// Secure messages between customers and the support team (Help > Message us).
//
// A conversation ("ticket") starts with the customer's first message and gets an
// automatic acknowledgement. The team answers from the admin panel; each answer
// notifies the customer. Status says whose turn it is:
//   open     -> waiting on the support team
//   answered -> the team replied, waiting on the customer
//   closed   -> done (a new customer message reopens it)
// Call-back requests are conversations too (category "callback"), carrying the
// phone number and time window the customer picked.

const CATEGORIES = {
  card: 'Card',
  transfer: 'Payments & transfers',
  account: 'My account',
  login: 'Signing in & security',
  fraud: "A charge I don't recognize",
  other: 'Something else',
  callback: 'Call back request',
};
const CALLBACK_WINDOWS = {
  asap: 'as soon as possible',
  morning: 'in the morning (8am–12pm ET)',
  afternoon: 'in the afternoon (12–5pm ET)',
  evening: 'in the evening (5–9pm ET)',
};
const MAX_SUBJECT = 120;
const MAX_BODY = 2000;
const MAX_OPEN = 5; // open or answered conversations per customer
const MAX_PER_HOUR = 20; // customer messages per rolling hour
const AGENT_NAME = 'Apex Support';

class SupportError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function ensureSupportSchema(sql) {
  await sql`
    CREATE TABLE IF NOT EXISTS support_tickets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL,
      subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      callback_phone TEXT,
      callback_window TEXT,
      customer_unread BOOLEAN NOT NULL DEFAULT FALSE,
      agent_unread BOOLEAN NOT NULL DEFAULT TRUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      closed_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS support_tickets_user_idx ON support_tickets (user_id, updated_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets (status, updated_at)`;
  await sql`
    CREATE TABLE IF NOT EXISTS support_messages (
      id SERIAL PRIMARY KEY,
      ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
      sender TEXT NOT NULL,
      agent_name TEXT,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS support_messages_ticket_idx ON support_messages (ticket_id, id)`;
}

// ----- Validation -----
function cleanText(value, max, label) {
  const text = String(value === undefined || value === null ? '' : value)
    .replace(/\r\n?/g, '\n')
    // Control characters other than newline and tab never belong in a message.
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, '')
    .trim();
  if (!text) throw new SupportError(400, `${label} can't be empty.`);
  if (text.length > max) throw new SupportError(400, `${label} is too long (${max.toLocaleString('en-US')} characters at most).`);
  return text;
}

function parseId(value) {
  const id = Number(value);
  if (!Number.isInteger(id) || id <= 0) throw new SupportError(400, 'That conversation was not found.');
  return id;
}

function cleanPhone(value) {
  const raw = String(value || '').trim();
  const digits = raw.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15 || !/^\+?[\d\s().-]+$/.test(raw)) {
    throw new SupportError(400, 'Enter a phone number we can call, like (555) 123-4567.');
  }
  return (raw.startsWith('+') ? '+' : '') + digits;
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `•••• ${digits.slice(-4)}` : 'your number';
}

function ackMessage(category, phone, windowKey) {
  if (category === 'callback') {
    return `Thanks, we've got your call-back request. Someone from our team will call ${maskPhone(phone)} ${CALLBACK_WINDOWS[windowKey]}, Monday to Friday. You can add details here in the meantime.`;
  }
  return "Thanks for your message. Our support team answers Monday to Friday, 8am–9pm ET, and we'll notify you as soon as we reply. For a lost or stolen card, freeze it from Help or the Cards tab right away.";
}

// ----- Shapes sent to the app -----
function shapeTicket(t) {
  return {
    id: Number(t.id),
    category: t.category,
    categoryLabel: CATEGORIES[t.category] || 'Something else',
    subject: t.subject,
    status: t.status,
    unread: t.customer_unread === true || t.customer_unread === 't',
    callbackPhone: t.callback_phone ? maskPhone(t.callback_phone) : null,
    callbackWindow: t.callback_window ? CALLBACK_WINDOWS[t.callback_window] || null : null,
    createdAt: t.created_at,
    updatedAt: t.updated_at,
    lastMessage: t.last_body === undefined ? undefined : {
      body: t.last_body ? String(t.last_body).slice(0, 160) : '',
      sender: t.last_sender,
      at: t.last_at,
    },
  };
}

function shapeMessage(m) {
  return {
    id: Number(m.id),
    sender: m.sender,
    agentName: m.sender === 'customer' ? null : (m.agent_name || AGENT_NAME),
    body: m.body,
    createdAt: m.created_at,
  };
}

// ----- Customer side -----
async function listTickets(sql, userId) {
  const rows = await sql`
    SELECT t.id, t.category, t.subject, t.status, t.customer_unread, t.callback_phone, t.callback_window,
           t.created_at, t.updated_at, lm.body AS last_body, lm.sender AS last_sender, lm.created_at AS last_at
    FROM support_tickets t
    LEFT JOIN LATERAL (
      SELECT body, sender, created_at FROM support_messages WHERE ticket_id = t.id ORDER BY id DESC LIMIT 1
    ) lm ON TRUE
    WHERE t.user_id = ${userId}
    ORDER BY (t.status = 'closed'), t.updated_at DESC, t.id DESC
    LIMIT 50
  `;
  const tickets = rows.map(shapeTicket);
  return {
    tickets,
    unread: tickets.filter((t) => t.unread).length,
    open: tickets.filter((t) => t.status !== 'closed').length,
    maxOpen: MAX_OPEN,
  };
}

async function supportSummary(sql, userId) {
  const rows = await sql`
    SELECT COUNT(*) FILTER (WHERE customer_unread) AS unread,
           COUNT(*) FILTER (WHERE status <> 'closed') AS open
    FROM support_tickets WHERE user_id = ${userId}
  `;
  return { unread: Number(rows[0].unread) || 0, open: Number(rows[0].open) || 0 };
}

async function getTicket(sql, userId, ticketId) {
  const id = parseId(ticketId);
  // Reading a conversation marks the team's replies as read.
  const rows = await sql`
    UPDATE support_tickets SET customer_unread = FALSE
    WHERE id = ${id} AND user_id = ${userId}
    RETURNING id, category, subject, status, customer_unread, callback_phone, callback_window, created_at, updated_at
  `;
  if (!rows.length) throw new SupportError(404, 'That conversation was not found.');
  const messages = await sql`
    SELECT id, sender, agent_name, body, created_at FROM support_messages
    WHERE ticket_id = ${id} ORDER BY id ASC
  `;
  return { ticket: shapeTicket(rows[0]), messages: messages.map(shapeMessage) };
}

async function recentCustomerMessages(sql, userId) {
  const rows = await sql`
    SELECT COUNT(*) AS n FROM support_messages m
    JOIN support_tickets t ON t.id = m.ticket_id
    WHERE t.user_id = ${userId} AND m.sender = 'customer' AND m.created_at > NOW() - INTERVAL '1 hour'
  `;
  return Number(rows[0].n) || 0;
}

const TOO_MANY = "You've sent a lot of messages in the last hour. Please wait a little before sending more.";

async function createTicket(sql, userId, input = {}) {
  const category = Object.prototype.hasOwnProperty.call(CATEGORIES, input.category) ? input.category : null;
  if (!category) throw new SupportError(400, 'Pick what your message is about.');
  let phone = null;
  let windowKey = null;
  let subject;
  let body;
  if (category === 'callback') {
    phone = cleanPhone(input.phone);
    windowKey = Object.prototype.hasOwnProperty.call(CALLBACK_WINDOWS, input.callbackWindow) ? input.callbackWindow : null;
    if (!windowKey) throw new SupportError(400, 'Pick a time for us to call.');
    const topic = input.topic && CATEGORIES[input.topic] && input.topic !== 'callback' ? CATEGORIES[input.topic] : null;
    subject = topic ? `Call back: ${topic}` : 'Call back request';
    const note = String(input.message || '').trim();
    body = cleanText(`Please call me ${CALLBACK_WINDOWS[windowKey]}.${note ? `\n\n${note}` : ''}`, MAX_BODY, 'Your note');
  } else {
    subject = cleanText(input.subject, MAX_SUBJECT, 'The subject');
    body = cleanText(input.message, MAX_BODY, 'Your message');
  }

  const counts = await sql`
    SELECT COUNT(*) AS n FROM support_tickets WHERE user_id = ${userId} AND status <> 'closed'
  `;
  if (Number(counts[0].n) >= MAX_OPEN) {
    throw new SupportError(409, `You already have ${MAX_OPEN} open conversations. Reply in one of those, or close one you no longer need.`);
  }
  if ((await recentCustomerMessages(sql, userId)) >= MAX_PER_HOUR) throw new SupportError(429, TOO_MANY);

  const ack = ackMessage(category, phone, windowKey);
  // One statement: the conversation, the first message and the acknowledgement
  // are saved together or not at all. The open-count guard is repeated here so
  // two quick submits can't slip past the limit.
  const rows = await sql`
    WITH ticket AS (
      INSERT INTO support_tickets (user_id, category, subject, callback_phone, callback_window)
      SELECT ${userId}::int, ${category}::text, ${subject}::text, ${phone}::text, ${windowKey}::text
      WHERE (SELECT COUNT(*) FROM support_tickets WHERE user_id = ${userId}::int AND status <> 'closed') < ${MAX_OPEN}::int
      RETURNING id
    ), first_message AS (
      INSERT INTO support_messages (ticket_id, sender, body)
      SELECT id, 'customer'::text, ${body}::text FROM ticket
      RETURNING id
    ), acknowledgement AS (
      INSERT INTO support_messages (ticket_id, sender, agent_name, body)
      SELECT ticket.id, 'system'::text, ${AGENT_NAME}::text, ${ack}::text FROM ticket, first_message
      RETURNING id
    )
    SELECT ticket.id FROM ticket, first_message, acknowledgement
  `;
  if (!rows.length) {
    throw new SupportError(409, `You already have ${MAX_OPEN} open conversations. Reply in one of those, or close one you no longer need.`);
  }
  return getTicket(sql, userId, rows[0].id);
}

async function replyAsCustomer(sql, userId, input = {}) {
  const id = parseId(input.ticketId);
  const body = cleanText(input.message, MAX_BODY, 'Your message');
  if ((await recentCustomerMessages(sql, userId)) >= MAX_PER_HOUR) throw new SupportError(429, TOO_MANY);
  // Replying (even to a closed conversation) puts it back in the team's queue.
  const rows = await sql`
    WITH mine AS (
      UPDATE support_tickets
      SET status = 'open', agent_unread = TRUE, updated_at = NOW(), closed_at = NULL
      WHERE id = ${id} AND user_id = ${userId}
      RETURNING id
    )
    INSERT INTO support_messages (ticket_id, sender, body)
    SELECT id, 'customer'::text, ${body}::text FROM mine
    RETURNING id
  `;
  if (!rows.length) throw new SupportError(404, 'That conversation was not found.');
  return getTicket(sql, userId, id);
}

async function closeAsCustomer(sql, userId, input = {}) {
  const id = parseId(input.ticketId);
  const rows = await sql`
    WITH closed AS (
      UPDATE support_tickets SET status = 'closed', closed_at = NOW(), updated_at = NOW(), agent_unread = FALSE
      WHERE id = ${id} AND user_id = ${userId} AND status <> 'closed'
      RETURNING id
    ), note AS (
      INSERT INTO support_messages (ticket_id, sender, agent_name, body)
      SELECT id, 'system'::text, ${AGENT_NAME}::text, 'You closed this conversation. Send a message any time to reopen it.'::text FROM closed
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM closed) AS closed_now,
           (SELECT COUNT(*) FROM support_tickets WHERE id = ${id} AND user_id = ${userId}) AS mine
  `;
  if (!Number(rows[0].mine)) throw new SupportError(404, 'That conversation was not found.');
  return getTicket(sql, userId, id);
}

// ----- Support team side (admin panel) -----
const ADMIN_FILTERS = ['open', 'answered', 'closed', 'all'];

async function adminListTickets(sql, { status = 'open' } = {}) {
  const filter = ADMIN_FILTERS.includes(status) ? status : 'open';
  const rows = await sql`
    SELECT t.id, t.category, t.subject, t.status, t.agent_unread, t.callback_phone, t.callback_window,
           t.created_at, t.updated_at, u.id AS user_id, u.email AS user_email, u.full_name AS user_full_name,
           lm.body AS last_body, lm.sender AS last_sender, lm.created_at AS last_at,
           (SELECT COUNT(*) FROM support_messages WHERE ticket_id = t.id) AS message_count
    FROM support_tickets t
    JOIN users u ON u.id = t.user_id
    LEFT JOIN LATERAL (
      SELECT body, sender, created_at FROM support_messages
      WHERE ticket_id = t.id AND sender <> 'system' ORDER BY id DESC LIMIT 1
    ) lm ON TRUE
    WHERE ${filter}::text = 'all' OR t.status = ${filter}::text
    ORDER BY CASE WHEN t.status = 'open' THEN 0 ELSE 1 END,
             CASE WHEN t.status = 'open' THEN t.updated_at END ASC,
             t.updated_at DESC
    LIMIT 200
  `;
  const counts = await sql`
    SELECT COUNT(*) FILTER (WHERE status = 'open') AS open,
           COUNT(*) FILTER (WHERE status = 'answered') AS answered,
           COUNT(*) FILTER (WHERE status = 'closed') AS closed
    FROM support_tickets
  `;
  return {
    tickets: rows.map((t) => ({
      id: Number(t.id),
      category: t.category,
      categoryLabel: CATEGORIES[t.category] || 'Something else',
      subject: t.subject,
      status: t.status,
      unread: t.agent_unread === true || t.agent_unread === 't',
      callbackPhone: t.callback_phone || null,
      callbackWindow: t.callback_window ? CALLBACK_WINDOWS[t.callback_window] || null : null,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      messageCount: Number(t.message_count) || 0,
      user: { id: Number(t.user_id), email: t.user_email, fullName: t.user_full_name },
      lastMessage: { body: t.last_body ? String(t.last_body).slice(0, 200) : '', sender: t.last_sender, at: t.last_at },
    })),
    counts: { open: Number(counts[0].open) || 0, answered: Number(counts[0].answered) || 0, closed: Number(counts[0].closed) || 0 },
    filter,
  };
}

async function adminGetTicket(sql, ticketId) {
  const id = parseId(ticketId);
  const rows = await sql`
    WITH seen AS (UPDATE support_tickets SET agent_unread = FALSE WHERE id = ${id} RETURNING *)
    SELECT seen.*, u.email AS user_email, u.full_name AS user_full_name
    FROM seen JOIN users u ON u.id = seen.user_id
  `;
  if (!rows.length) throw new SupportError(404, 'That conversation was not found.');
  const t = rows[0];
  const messages = await sql`
    SELECT id, sender, agent_name, body, created_at FROM support_messages WHERE ticket_id = ${id} ORDER BY id ASC
  `;
  return {
    ticket: {
      id: Number(t.id),
      category: t.category,
      categoryLabel: CATEGORIES[t.category] || 'Something else',
      subject: t.subject,
      status: t.status,
      callbackPhone: t.callback_phone || null, // the team sees the full number to call
      callbackWindow: t.callback_window ? CALLBACK_WINDOWS[t.callback_window] || null : null,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
      user: { id: Number(t.user_id), email: t.user_email, fullName: t.user_full_name },
    },
    messages: messages.map(shapeMessage),
  };
}

async function adminReply(sql, input = {}) {
  const id = parseId(input.ticketId);
  const body = cleanText(input.message, MAX_BODY, 'The reply');
  const agentName = String(input.agentName || '').trim().slice(0, 60) || AGENT_NAME;
  const rows = await sql`
    WITH t AS (
      UPDATE support_tickets
      SET status = 'answered', customer_unread = TRUE, agent_unread = FALSE, updated_at = NOW(), closed_at = NULL
      WHERE id = ${id}
      RETURNING id, user_id, subject
    ), m AS (
      INSERT INTO support_messages (ticket_id, sender, agent_name, body)
      SELECT id, 'agent'::text, ${agentName}::text, ${body}::text FROM t
      RETURNING id
    )
    SELECT t.id, t.user_id, t.subject FROM t, m
  `;
  if (!rows.length) throw new SupportError(404, 'That conversation was not found.');
  const preview = body.length > 140 ? `${body.slice(0, 137)}…` : body;
  return {
    ticketId: id,
    userId: Number(rows[0].user_id),
    notification: { title: 'Support replied', message: `Re: ${rows[0].subject} — ${preview}` },
  };
}

async function adminClose(sql, input = {}) {
  const id = parseId(input.ticketId);
  const rows = await sql`
    WITH t AS (
      UPDATE support_tickets
      SET status = 'closed', closed_at = NOW(), updated_at = NOW(), agent_unread = FALSE, customer_unread = TRUE
      WHERE id = ${id} AND status <> 'closed'
      RETURNING id, user_id
    ), note AS (
      INSERT INTO support_messages (ticket_id, sender, agent_name, body)
      SELECT id, 'system'::text, ${AGENT_NAME}::text, 'Our team closed this conversation. Send a message any time to reopen it.'::text FROM t
      RETURNING id
    )
    SELECT (SELECT COUNT(*) FROM t) AS closed_now, (SELECT COUNT(*) FROM support_tickets WHERE id = ${id}) AS found
  `;
  if (!Number(rows[0].found)) throw new SupportError(404, 'That conversation was not found.');
  return { ticketId: id, closed: Number(rows[0].closed_now) > 0 };
}

module.exports = {
  CATEGORIES,
  CALLBACK_WINDOWS,
  MAX_BODY,
  MAX_SUBJECT,
  MAX_OPEN,
  MAX_PER_HOUR,
  SupportError,
  ensureSupportSchema,
  listTickets,
  supportSummary,
  getTicket,
  createTicket,
  replyAsCustomer,
  closeAsCustomer,
  adminListTickets,
  adminGetTicket,
  adminReply,
  adminClose,
  maskPhone,
};
