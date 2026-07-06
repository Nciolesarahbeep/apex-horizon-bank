const { neon } = require('@neondatabase/serverless');

module.exports = async (req, res) => {
  // Allows your frontend bank interface to connect securely
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Grabs the credentials typed into your login form
    const { email, password } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    
    // Connects to your database automatically using Vercel's link
    const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    const sql = neon(connectionString);
    
    // Verifies if the email exists in your accounts table
    const users = await sql`SELECT * FROM accounts WHERE email = ${email};`;
    
    // If user doesn't exist or password fails, reject the login cleanly
    if (users.length === 0 || users[0].password !== password) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Success! Pass your user data back to load the dashboard view
    return res.status(200).json(users[0]);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
