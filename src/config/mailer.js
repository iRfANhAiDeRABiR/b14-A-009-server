import nodemailer from "nodemailer";
import { redactMongoUri } from "./env.js";
import { cleanString } from "../validators/validationHelpers.js";

const PLACEHOLDER_VALUES = ["your_", "your-", "placeholder", "example.com"];

function isConfiguredMailerValue(raw) {
  const clean = cleanString(raw);
  if (!clean) return false;
  const lower = clean.toLowerCase();
  if (lower.startsWith("<") && lower.endsWith(">")) return false;
  return !PLACEHOLDER_VALUES.some((hint) => lower.includes(hint));
}

/**
 * Resolves optional SMTP email notification configuration from environment variables.
 * Never logs credentials or blocks core API execution when credentials are absent.
 */
export function resolveMailConfig() {
  const host = cleanString(process.env.MAIL_HOST);
  const rawPort = cleanString(process.env.MAIL_PORT);
  const port = rawPort ? Number(rawPort) : 587;
  const user = cleanString(process.env.MAIL_USER);
  const pass = cleanString(process.env.MAIL_PASSWORD);
  const from = cleanString(process.env.MAIL_FROM) || user;
  const rawSecure = cleanString(process.env.MAIL_SECURE).toLowerCase();
  const secure = rawSecure ? rawSecure === "true" : port === 465;

  const hasValidPort = Number.isInteger(port) && port >= 1 && port <= 65535;
  const configured =
    hasValidPort &&
    isConfiguredMailerValue(host) &&
    isConfiguredMailerValue(user) &&
    Boolean(pass) &&
    isConfiguredMailerValue(from);

  return {
    configured,
    host,
    port: hasValidPort ? port : 587,
    secure,
    user,
    pass,
    from,
  };
}

/**
 * Factory creating a reusable SMTP transport wrapper that degrades safely when unconfigured.
 */
export function createMailer({
  nodemailerLib = nodemailer,
  configResolver = resolveMailConfig,
} = {}) {
  let cachedTransport = null;
  let cachedSignature = "";

  function resolveTransport() {
    const config = configResolver();
    if (!config.configured) {
      return { configured: false, config, transport: null };
    }

    const signature = `${config.host}:${config.port}:${config.secure}:${config.user}`;
    if (!cachedTransport || cachedSignature !== signature) {
      cachedTransport = nodemailerLib.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: {
          user: config.user,
          pass: config.pass,
        },
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 10000,
      });
      cachedSignature = signature;
    }

    return { configured: true, config, transport: cachedTransport };
  }

  return {
    isConfigured() {
      return Boolean(configResolver().configured);
    },

    async sendMail({ to, subject, text, html }) {
      const cleanRecipient = cleanString(to);
      if (!cleanRecipient) {
        return { sent: false, skipped: true, reason: "MISSING_RECIPIENT" };
      }

      const { configured, config, transport } = resolveTransport();
      if (!configured || !transport) {
        return { sent: false, skipped: true, reason: "SMTP_NOT_CONFIGURED" };
      }

      try {
        const info = await transport.sendMail({
          from: config.from,
          to: cleanRecipient,
          subject: cleanString(subject),
          text: String(text || ""),
          ...(html ? { html: String(html) } : {}),
        });

        return {
          sent: true,
          skipped: false,
          messageId: info?.messageId || null,
        };
      } catch (error) {
        const safeErr = redactMongoUri(
          error?.message || "Temporary SMTP delivery failure"
        );
        console.error(`[GearNest Mailer] Delivery failed: ${safeErr}`);
        return {
          sent: false,
          skipped: false,
          reason: safeErr,
        };
      }
    },
  };
}

export const mailer = createMailer();
