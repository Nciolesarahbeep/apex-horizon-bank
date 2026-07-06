const { neon } = require('@neondatabase/serverless');

module.exports = async (req, res) => {
  // Allows your frontend HTML file to read this data safely
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  
  try {
    // Connects securely using your Vercel hidden database URL variable
    const sql = neon(process.env.DATABASE_URL);
    
    // Grabs your bank accounts table data
    const data = await sql`SELECT * FROM accounts;`;
    
    return res.status(200).json(data);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
};
