const { neon } = require('@neondatabase/serverless');
const { getUserFromRequest } = require('../lib/auth');

const sql = neon(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const MAX_PHOTO_BYTES = 400 * 1024; // ~400KB base64 ceiling, comfortably above a 240x240 JPEG

module.exports = async function handler(req, res) {
  const session = await getUserFromRequest(req);
  if (!session) {
    return res.status(401).json({ error: 'Not authenticated' });
  }

  if (req.method === 'POST') {
    const { photoDataUrl } = req.body || {};
    if (!photoDataUrl || typeof photoDataUrl !== 'string' || !photoDataUrl.startsWith('data:image/')) {
      return res.status(400).json({ error: 'Invalid photo data.' });
    }
    if (photoDataUrl.length > MAX_PHOTO_BYTES) {
      return res.status(400).json({ error: 'Photo is too large.' });
    }

    try {
      await sql`UPDATE users SET profile_photo = ${photoDataUrl} WHERE id = ${session.userId}`;
      return res.status(200).json({ success: true, profilePhoto: photoDataUrl });
    } catch (err) {
      console.error('Profile photo save error:', err);
      return res.status(500).json({ error: 'Could not save photo.' });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await sql`UPDATE users SET profile_photo = NULL WHERE id = ${session.userId}`;
      return res.status(200).json({ success: true });
    } catch (err) {
      console.error('Profile photo delete error:', err);
      return res.status(500).json({ error: 'Could not remove photo.' });
    }
  }

  res.setHeader('Allow', 'POST, DELETE');
  return res.status(405).json({ error: 'Method not allowed' });
};
