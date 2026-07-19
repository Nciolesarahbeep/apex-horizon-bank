    // ---------- apply(principal, annualRate, termMonths, purpose, monthlyIncome, employmentStatus) ----------
    if (action === 'apply') {
      const principal = Number(req.body.principal);
      const annualRate = Number(req.body.annualRate);
      const termMonths = Number(req.body.termMonths);
      const purpose = String(req.body.purpose || '').trim();
      const monthlyIncome = Number(req.body.monthlyIncome);
      const employmentStatus = String(req.body.employmentStatus || '').trim();

      if (!Number.isFinite(principal) || principal < 1000 || principal > 250000) {
        return res.status(400).json({ error: 'Loan amount must be between $1,000 and $250,000.' });
      }
      if (!Number.isFinite(termMonths) || termMonths < 6 || termMonths > 84) {
        return res.status(400).json({ error: 'Term must be between 6 and 84 months.' });
      }
      if (!Number.isFinite(annualRate) || annualRate <= 0 || annualRate > 0.30) {
        return res.status(400).json({ error: 'Invalid interest rate.' });
      }
      if (!purpose) {
        return res.status(400).json({ error: 'Please tell us the purpose of this loan.' });
      }
      if (!Number.isFinite(monthlyIncome) || monthlyIncome <= 0) {
        return res.status(400).json({ error: 'Please enter a valid monthly income.' });
      }
      if (!employmentStatus) {
        return res.status(400).json({ error: 'Please select your employment status.' });
      }

      const accountRows = await sql`
        SELECT COALESCE(SUM(balance), 0) AS total_balance
        FROM accounts WHERE user_id = ${user.id}
      `;
      const totalBalance = Number(accountRows[0].total_balance);
      if (totalBalance < principal * 0.10) {
        return res.status(400).json({
          error: `Based on your current balances, you're not eligible for a loan this large. Try a lower amount or check back after your balance grows.`
        });
      }

      const { monthlyPayment, totalInterest, totalPaid } = calculateAmortization(principal, annualRate, termMonths);

      const checkingRows = await sql`
        SELECT id FROM accounts WHERE user_id = ${user.id} AND account_type = 'checking' LIMIT 1
      `;
      if (checkingRows.length === 0) {
        return res.status(400).json({ error: 'No checking account found to attach this loan to.' });
      }

      const userRows = await sql`SELECT full_name FROM users WHERE id = ${user.id} LIMIT 1`;
      const applicantName = userRows[0]?.full_name || null;

      const loanRows = await sql`
        INSERT INTO loans (user_id, account_id, principal, interest_rate, term_months, monthly_payment, status, purpose, monthly_income, employment_status, applicant_name)
        VALUES (${user.id}, ${checkingRows[0].id}, ${principal}, ${annualRate}, ${termMonths}, ${monthlyPayment}, 'pending', ${purpose}, ${monthlyIncome}, ${employmentStatus}, ${applicantName})
        RETURNING id, principal, interest_rate, term_months, monthly_payment, status, purpose, created_at
      `;

      return res.status(200).json({
        success: true,
        message: 'Application submitted successfully. Your loan is pending review and you\'ll be notified once a decision is made.',
        loan: loanRows[0],
        summary: { monthlyPayment, totalInterest, totalPaid }
      });
    }
