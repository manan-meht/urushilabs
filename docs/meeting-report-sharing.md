# Sharing a meeting report

From the meeting status page, once the report exists, the case owner can:

- **Download PDF** — opens `/meeting/<reference>/report?print=1`, a clean
  print-ready copy of the report, and triggers the browser's print dialog where
  "Save as PDF" is the destination. The browser renders the PDF because it is
  the only renderer available to us that shapes Devanagari correctly; reports
  follow the meeting's language. A server-generated attachment would need
  Cloudflare Browser Rendering (Workers Paid plan).
- **Email report** — `POST /api/meeting/sessions/<id>/report/email` with up to
  10 recipients and an optional note. The full report goes inline (the report
  page is owner-only, so a link alone would not work for recipients); replies go
  to the owner. Limited to 10 sends per case per hour. Only the recipient
  *count* is recorded, as a `meeting_report_emailed` audit event.

Email needs two Cloudflare secrets: `RESEND_API_KEY` and `EMAIL_FROM` (an
address on a domain verified in Resend). Without them the endpoint answers 503
and the form says email is not set up yet.
