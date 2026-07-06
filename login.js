const { neon } = require('@neondatabase/serverless');

module.exports = async (req, res) => {
  // Allows your mobile banking app interface to connect securely
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    // Extract login inputs passed from the frontend interface
    const { email, password } = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    
    // Connect securely using Vercel's existing connection string
    const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;
    const sql = neon(connectionString);
    
    // Check if a user with this email exists in your accounts table
    const users = await sql`SELECT * FROM accounts WHERE email = ${email};`;
    
    // If user is missing or password doesn't match, return a clear login failure
    if (users.length === 0 || users[0].password !== password) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Success! Return the user's name and balance data back to your banking dashboard
    return res.status(200).json(users[0]);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
