const fs = require("node:fs");
const path = require("node:path");

function configureGoogleCalendar(credentialsPath, envPath) {
  const credentials = JSON.parse(fs.readFileSync(credentialsPath, "utf8")).installed;
  if (
    !credentials ||
    typeof credentials.client_id !== "string" ||
    !credentials.client_id.endsWith(".apps.googleusercontent.com") ||
    typeof credentials.client_secret !== "string" ||
    !credentials.client_secret.trim() ||
    /[\r\n]/.test(credentials.client_id + credentials.client_secret)
  ) {
    throw new Error(
      "Choose the downloaded Google OAuth Desktop app JSON, not a Web client or API key."
    );
  }
  const values = {
    GOOGLE_CALENDAR_CLIENT_ID: credentials.client_id,
    GOOGLE_CALENDAR_CLIENT_SECRET: credentials.client_secret,
  };
  const original = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
  const lines = original
    .split(/\r?\n/)
    .filter((line) => !/^\s*(?:export\s+)?GOOGLE_CALENDAR_CLIENT_(?:ID|SECRET)\s*=/.test(line));
  for (const [key, value] of Object.entries(values)) {
    // dotenv treats # as a comment outside quotes. Google's credentials do not
    // contain quotes; reject them rather than writing an ambiguous env value.
    if (/["'`]/.test(value)) throw new Error("Unexpected characters in OAuth credentials.");
    lines.push(`${key}="${value}"`);
  }
  fs.mkdirSync(path.dirname(envPath), { recursive: true });
  fs.writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });
}

if (require.main === module) {
  try {
    if (!process.argv[2] || !process.env.APPDATA) {
      throw new Error(
        'Usage on Windows: node scripts/configure-google-calendar.js "C:\\path\\client.json"'
      );
    }
    configureGoogleCalendar(process.argv[2], path.join(process.env.APPDATA, "open-whispr", ".env"));
    console.log("Google Calendar client configured locally. Restart OpenWhispr and click Connect.");
  } catch (error) {
    // Parser errors can include input; never echo downloaded credentials.
    console.error(error instanceof SyntaxError ? "Invalid credentials JSON." : error.message);
    process.exitCode = 1;
  }
}

module.exports = { configureGoogleCalendar };
