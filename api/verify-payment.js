const TICKETS = {
  early_single: { label: 'Early Bird — Single', amount: 5000 },
  early_group: { label: 'Early Bird — Group of 4', amount: 18000 },
  wave_single: { label: 'First Wave — Single', amount: 7000 },
  wave_group: { label: 'First Wave — Group of 4', amount: 26000 }
};

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[character]));
}

async function sendTicketEmail({ email, name, ticket, reference }) {
  if (!process.env.RESEND_API_KEY || !process.env.RESEND_FROM_EMAIL) {
    throw new Error('Email delivery is not configured.');
  }

  const ticketNumber = 'GT-' + reference;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json',
      'User-Agent': 'gametribe-ticketing/1.0',
      'Idempotency-Key': 'ticket-' + reference
    },
    body: JSON.stringify({
      from: process.env.RESEND_FROM_EMAIL,
      to: [email],
      subject: 'Your Game Tribe ticket — ' + ticketNumber,
      html: `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;color:#1C1410">
        <div style="background:#E8342A;color:#FFF6E5;padding:24px;border-radius:16px 16px 0 0"><h1 style="margin:0">GAME TRIBE</h1><p style="margin:8px 0 0">Your reservation is confirmed</p></div>
        <div style="border:2px solid #1C1410;border-top:0;padding:24px;border-radius:0 0 16px 16px"><p>Hi ${escapeHtml(name)},</p><p>Your payment has been verified. Show this email at the event entrance.</p><p><strong>Ticket:</strong> ${escapeHtml(ticket.label)}<br><strong>Ticket number:</strong> ${escapeHtml(ticketNumber)}<br><strong>Paystack reference:</strong> ${escapeHtml(reference)}</p><p>We can’t wait to see you.</p></div>
      </div>`,
      text: `Game Tribe ticket confirmed\n\nHi ${name},\nTicket: ${ticket.label}\nTicket number: ${ticketNumber}\nPaystack reference: ${reference}`
    })
  });

  if (!response.ok) throw new Error('Resend could not deliver the ticket email.');
  return ticketNumber;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ message: 'Method not allowed.' });
  }

  if (!process.env.PAYSTACK_SECRET_KEY) {
    return res.status(500).json({ message: 'Payment verification is not configured.' });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const reference = String(body.reference || '');
  const requestedType = body.buyer && body.buyer.ticketType;

  if (!reference || !TICKETS[requestedType]) {
    return res.status(400).json({ message: 'Invalid payment reference or ticket type.' });
  }

  try {
    const paystackResponse = await fetch(
      'https://api.paystack.co/transaction/verify/' + encodeURIComponent(reference),
      { headers: { Authorization: 'Bearer ' + process.env.PAYSTACK_SECRET_KEY } }
    );
    const paystack = await paystackResponse.json();
    const transaction = paystack.data;
    const ticket = TICKETS[requestedType];

    if (!paystackResponse.ok || !paystack.status || !transaction || transaction.status !== 'success') {
      return res.status(400).json({ message: 'Paystack has not confirmed this payment.' });
    }
    if (transaction.currency !== 'NGN' || transaction.amount !== ticket.amount * 100) {
      return res.status(400).json({ message: 'The payment amount does not match this ticket type.' });
    }
    if (!transaction.metadata || transaction.metadata.ticket_type !== requestedType) {
      return res.status(400).json({ message: 'The ticket details do not match the payment.' });
    }

    const buyer = body.buyer || {};
    if (!buyer.email || !buyer.name || buyer.email.toLowerCase() !== String(transaction.customer.email || '').toLowerCase()) {
      return res.status(400).json({ message: 'The buyer details do not match the payment.' });
    }

    const ticketNumber = await sendTicketEmail({
      email: buyer.email,
      name: buyer.name,
      ticket,
      reference: transaction.reference
    });

    // Add a database before launch to enforce the Early Bird limits and retain orders.
    // Do not use the function filesystem for orders; Vercel Functions are stateless.
    return res.status(200).json({
      verified: true,
      ticketNumber,
      reference: transaction.reference,
      ticket: ticket.label
    });
  } catch (error) {
    return res.status(502).json({ message: 'Unable to verify the payment with Paystack.' });
  }
}
