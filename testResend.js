require("dotenv").config();
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

(async () => {
  try {
    const result = await resend.emails.send({
      from: "onboarding@resend.dev",
      to: "your-email@example.com",
      subject: "Test Email",
      html: "<p>Hello world!</p>",
    });
    console.log("✅ Email sent:", result);
  } catch (err) {
    console.error("❌ Resend error:", err.message);
  }
})();
