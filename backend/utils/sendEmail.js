const nodemailer = require('nodemailer');

const MAIL_TIMEOUT = 5000; // 5 second timeout

const sendEmail = async (options) => {
  // Create a transporter
  // For production, use SendGrid, Mailgun, or AWS SES
  // For this project, we can use a Gmail account or Ethereal (fake)
  
  // NOTE - If using Gmail, you need "App Password" enabled.
  // For now, I'll log the email to console if no credentials are provided
  
  const transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.mailtrap.io',
    port: process.env.SMTP_PORT || 2525,
    auth: {
      user: process.env.SMTP_EMAIL || 'user',
      pass: process.env.SMTP_PASSWORD || 'pass'
    },
    connectionTimeout: MAIL_TIMEOUT,
    socketTimeout: MAIL_TIMEOUT
  });

  const message = {
    from: `${process.env.FROM_NAME || 'MissingPersonAI'} <${process.env.FROM_EMAIL || 'noreply@missingperson.ai'}>`,
    to: options.email,
    subject: options.subject,
    text: options.message,
    html: `<b>${options.message}</b>` // simplified
  };

  try {
      if (!process.env.SMTP_HOST) {
          console.log("---------------------------------------------------");
          console.log("MOCK EMAIL SENT:");
          console.log(`To: ${options.email}`);
          console.log(`Subject: ${options.subject}`);
          console.log(`Message: ${options.message}`);
          console.log("---------------------------------------------------");
          return; 
      }
      
      // Add timeout wrapper
      const sendPromise = transporter.sendMail(message);
      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Email send timeout')), MAIL_TIMEOUT)
      );
      
      const info = await Promise.race([sendPromise, timeoutPromise]);
      console.log('Message sent: %s', info.messageId);
  } catch(error) {
      console.error("Email send error:", error);
      // Fallback logging
      console.log("---------------------------------------------------");
      console.log("EMAIL FAILED TO SEND (CHECK CREDENTIALS), LOGGING CONTENT:");
      console.log(`To: ${options.email}`);
      console.log(`Subject: ${options.subject}`);
      console.log(`Message: ${options.message}`);
      console.log("---------------------------------------------------");
      throw error;
  }
};

module.exports = sendEmail;
