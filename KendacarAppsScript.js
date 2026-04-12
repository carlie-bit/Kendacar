/**
 * -----------------------------------------------------------------------------
 *  KENDACAR FOUNDATION - Google Apps Script
 *  Paste into Extensions > Apps Script in your Google Sheet.
 * -----------------------------------------------------------------------------
 *
 *  SETUP (do these in order):
 *  1. Edit CONFIG below with your real values (email, EIN, dashboard URL).
 *  2. Run createKendacarForm() - builds + links the form automatically.
 *  3. Run setupTriggers() - installs the automation.
 *  4. Run testCompletionEmail() and testDonationReceipt() to preview emails.
 *  5. Share the form URL with family members.
 *
 * -----------------------------------------------------------------------------
 */

// --- CONFIG - EDIT THESE -----------------------------------------------------
const CONFIG = {
  ADMIN_EMAIL: "your@email.com",
  FOUNDATION_NAME: "Kendacar Foundation",
  FOUNDATION_EIN: "XX-XXXXXXX",
  DASHBOARD_URL: "https://your-username.github.io/kendacar-dashboard/",
  TEAL: "#0B6E6E",
  TEAL_LIGHT: "#A8D5D5",
  TEAL_BG: "#E8F5F5",
  RESPONSE_SHEET_NAME: "Form Responses 1",
  ORG_SHEET_NAME: "Organizations",
  // Column positions in the Sheet (1-based). If you add/remove form fields, update these.
  COLS: {
    TIMESTAMP: 1,
    REQUESTER_NAME: 2,
    REQUESTER_EMAIL: 3,
    ORG_DROPDOWN: 4,
    ORG_OTHER: 5,
    ORG_TYPE: 6,
    AMOUNT: 7,
    NOTES: 8,
    IS_DONATION_IN: 9,
    DONOR_NAME: 10,
    DONOR_AMOUNT: 11,
    // Manually filled after check is written:
    CHECK_DATE: 13,
    CHECK_NUM: 14,
    STATUS: 15,
  }
};

// --- PRE-LOADED ORGANIZATIONS -------------------------------------------------
// Edit this list - these will appear as dropdown options in the form.
const ORGANIZATIONS = [
  "CASA of McHenry County",
  "Turning Point",
  "Northern Illinois Food Bank",
  "Centegra Health Foundation",
  "Midwest Shelter for Homeless Veterans",
  "McHenry County Animal Control",
  "Other / New Organization",  // Always keep this last
];

const ORG_TYPES = [
  "Children & Youth",
  "Domestic Violence",
  "Food & Hunger",
  "Healthcare",
  "Veterans",
  "Animal Welfare",
  "Arts & Culture",
  "Education",
  "Religious",
  "Other",
];

// --- CREATE FORM -------------------------------------------------------------
/**
 * Run this ONCE to build the Google Form and link it to this spreadsheet.
 * After running, find the form in your Google Drive.
 * Share the form's "prefilled link" or "published link" with family members.
 */
function createKendacarForm() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // Create the form
  const form = FormApp.create("Kendacar Foundation - Grant Request");
  form.setDescription(
    "Submit a grant recommendation or log a donation to the Kendacar Foundation. " +
    "All submissions are reviewed by the Foundation administrator."
  );
  form.setConfirmationMessage(
    "Thank you! Your request has been received. You'll get a confirmation email once the check has been written."
  );
  form.setCollectEmail(false); // We ask for email manually so it's visible in the sheet
  form.setAllowResponseEdits(false);
  form.setLimitOneResponsePerUser(false); // Allow multiple submissions

  // -- Section 1: Who's asking ----------------------------------------------
  form.addSectionHeaderItem()
    .setTitle("About You");

  form.addTextItem()
    .setTitle("Your Name")
    .setRequired(true);

  form.addTextItem()
    .setTitle("Your Email")
    .setRequired(true)
    .setHelpText("We'll send your confirmation here once the check is written.");

  // -- Section 2: Grant request ---------------------------------------------
  form.addSectionHeaderItem()
    .setTitle("Grant Request");

  const orgItem = form.addListItem()
    .setTitle("Organization Name")
    .setRequired(true)
    .setHelpText("Select from the list, or choose \"Other / New Organization\" to add a new one.");
  orgItem.setChoiceValues(ORGANIZATIONS);

  form.addTextItem()
    .setTitle("If \"Other / New Organization\", enter the name here")
    .setRequired(false)
    .setHelpText("Leave blank if you selected an existing organization above.");

  const typeItem = form.addMultipleChoiceItem()
    .setTitle("Organization Type / Focus Area")
    .setRequired(true);
  typeItem.setChoiceValues(ORG_TYPES);

  form.addTextItem()
    .setTitle("Grant Amount Requested ($)")
    .setRequired(true)
    .setHelpText("Enter numbers only, e.g. 10000");

  form.addParagraphTextItem()
    .setTitle("Purpose / Notes")
    .setRequired(false)
    .setHelpText("Optional - what is this grant for? Any context that would be helpful.");

  // -- Section 3: Donation to Kendacar --------------------------------------
  form.addSectionHeaderItem()
    .setTitle("Logging a Donation to Kendacar")
    .setHelpText("Only fill this section if you're recording an incoming donation to the Foundation (not a grant out).");

  const donCheckbox = form.addCheckboxItem()
    .setTitle("This is a donation TO the Kendacar Foundation (not a grant request)")
    .setRequired(false);
  donCheckbox.setChoiceValues(["Yes, log this as an incoming donation"]);

  form.addTextItem()
    .setTitle("Donor Name")
    .setRequired(false);

  form.addTextItem()
    .setTitle("Donation Amount ($)")
    .setRequired(false)
    .setHelpText("Enter numbers only, e.g. 50000");

  // -- Link form to this spreadsheet ----------------------------------------
  form.setDestination(FormApp.DestinationType.SPREADSHEET, ss.getId());

  // Log the form URL
  const formUrl = form.getPublishedUrl();
  const editUrl = form.getEditUrl();

  Logger.log("[OK] Form created successfully!");
  Logger.log(" Share this URL with family members: " + formUrl);
  Logger.log("  Edit the form here: " + editUrl);

  // Write URLs to a reference sheet for easy access
  let refSheet = ss.getSheetByName("Setup Info");
  if (!refSheet) refSheet = ss.insertSheet("Setup Info");
  refSheet.clearContents();
  refSheet.getRange("A1:B6").setValues([
    ["Kendacar Foundation - Setup Info", ""],
    ["", ""],
    ["Family Form URL (share this)", formUrl],
    ["Form Edit URL (admin only)", editUrl],
    ["Dashboard URL", CONFIG.DASHBOARD_URL],
    ["Script last run", new Date().toLocaleString()],
  ]);
  refSheet.getRange("A1").setFontWeight("bold").setFontSize(13);
  refSheet.getRange("A3:A6").setFontWeight("bold");
  refSheet.setColumnWidth(1, 240);
  refSheet.setColumnWidth(2, 420);

  SpreadsheetApp.getUi().alert(
    "[OK] Form created!\n\n" +
    "The form URL has been saved to the \"Setup Info\" sheet in this spreadsheet.\n\n" +
    "Next step: Run setupTriggers() to install the email automation."
  );
}

// --- TRIGGER SETUP -----------------------------------------------------------
/**
 * Run ONCE after createKendacarForm(). Installs form submit + edit triggers.
 */
function setupTriggers() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  ScriptApp.newTrigger("onFormSubmitHandler")
    .forSpreadsheet(ss)
    .onFormSubmit()
    .create();

  ScriptApp.newTrigger("onEditHandler")
    .forSpreadsheet(ss)
    .onEdit()
    .create();

  Logger.log("[OK] Triggers installed.");
  SpreadsheetApp.getUi().alert("[OK] Triggers installed!\n\nThe system is now live. Run testCompletionEmail() to preview what family members will receive.");
}

// --- FORM SUBMIT HANDLER -----------------------------------------------------
function onFormSubmitHandler(e) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName(CONFIG.RESPONSE_SHEET_NAME);
  const row = e.range.getRow();
  const data = sheet.getRange(row, 1, 1, 12).getValues()[0];

  const name        = data[CONFIG.COLS.REQUESTER_NAME - 1] || "Unknown";
  const email       = data[CONFIG.COLS.REQUESTER_EMAIL - 1] || "";
  const orgDropdown = data[CONFIG.COLS.ORG_DROPDOWN - 1] || "";
  const orgOther    = data[CONFIG.COLS.ORG_OTHER - 1] || "";
  const orgName     = orgDropdown === "Other / New Organization" ? orgOther : orgDropdown;
  const orgType     = data[CONFIG.COLS.ORG_TYPE - 1] || "";
  const amount      = data[CONFIG.COLS.AMOUNT - 1] || 0;
  const notes       = data[CONFIG.COLS.NOTES - 1] || "";
  const isDonation  = String(data[CONFIG.COLS.IS_DONATION_IN - 1]).includes("Yes");
  const donorName   = data[CONFIG.COLS.DONOR_NAME - 1] || "";
  const donorAmount = data[CONFIG.COLS.DONOR_AMOUNT - 1] || 0;

  if (isDonation) {
    handleIncomingDonation_(donorName, donorAmount, email, name);
    return;
  }

  if (orgDropdown === "Other / New Organization" && orgOther) {
    addNewOrg_(orgOther, orgType);
  }

  sheet.getRange(row, CONFIG.COLS.STATUS).setValue("Pending");

  const subject = `[Kendacar] Grant Request - ${orgName} - $${Number(amount).toLocaleString()}`;
  const body = [
    `New grant request submitted.`,
    ``,
    `Requested by: ${name} (${email})`,
    `Organization: ${orgName}`,
    `Type: ${orgType}`,
    `Amount: $${Number(amount).toLocaleString()}`,
    `Notes: ${notes || "None"}`,
    ``,
    `Submitted: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}`,
    ``,
    `To process: open the spreadsheet, write the check, fill in Check Date + Check #, then set Status to "Complete" to send the confirmation email.`,
    ``,
    `Dashboard: ${CONFIG.DASHBOARD_URL}`,
  ].join("\n");

  MailApp.sendEmail({ to: CONFIG.ADMIN_EMAIL, subject, body });
}

// --- EDIT HANDLER ------------------------------------------------------------
function onEditHandler(e) {
  const sheet = e.range.getSheet();
  if (sheet.getName() !== CONFIG.RESPONSE_SHEET_NAME) return;
  if (e.range.getRow() === 1) return;
  if (e.range.getColumn() !== CONFIG.COLS.STATUS) return;
  if (e.range.getValue() !== "Complete") return;

  const row  = e.range.getRow();
  const data = sheet.getRange(row, 1, 1, 15).getValues()[0];

  const name        = data[CONFIG.COLS.REQUESTER_NAME - 1] || "";
  const email       = data[CONFIG.COLS.REQUESTER_EMAIL - 1] || "";
  const orgDropdown = data[CONFIG.COLS.ORG_DROPDOWN - 1] || "";
  const orgOther    = data[CONFIG.COLS.ORG_OTHER - 1] || "";
  const orgName     = orgDropdown === "Other / New Organization" ? orgOther : orgDropdown;
  const orgType     = data[CONFIG.COLS.ORG_TYPE - 1] || "";
  const amount      = data[CONFIG.COLS.AMOUNT - 1] || 0;
  const notes       = data[CONFIG.COLS.NOTES - 1] || "";
  const checkDate   = data[CONFIG.COLS.CHECK_DATE - 1] || "";
  const checkNum    = data[CONFIG.COLS.CHECK_NUM - 1] || "";

  if (!email) return;
  sendCompletionEmail_(name, email, orgName, orgType, amount, checkDate, checkNum, notes);
}

// --- COMPLETION EMAIL ---------------------------------------------------------
function sendCompletionEmail_(name, email, orgName, orgType, amount, checkDate, checkNum, notes) {
  const fmtDate = d => d ? new Date(d).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "-";
  const fmtAmt  = n => `$${Number(n).toLocaleString()}`;
  const year    = new Date().getFullYear();

  const subject  = `[${CONFIG.FOUNDATION_NAME}] Grant Confirmed - ${orgName}`;
  const htmlBody = `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Georgia,serif;color:#111D1D;max-width:560px;margin:0 auto;padding:0;">

  <div style="background:${CONFIG.TEAL};color:#fff;padding:32px 36px 28px;">
    <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${CONFIG.TEAL_LIGHT};margin-bottom:6px;">Family Philanthropy</div>
    <h1 style="margin:0;font-size:26px;font-weight:700;line-height:1.2;">${CONFIG.FOUNDATION_NAME}</h1>
    <div style="font-size:13px;color:${CONFIG.TEAL_LIGHT};margin-top:6px;">Grant Confirmation</div>
  </div>

  <div style="padding:32px 36px;">
    <p style="font-size:15px;line-height:1.6;margin:0 0 20px;">Dear ${name},</p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 24px;">
      We're pleased to confirm that a grant has been issued on behalf of the
      ${CONFIG.FOUNDATION_NAME} to the following organization:
    </p>

    <div style="background:${CONFIG.TEAL_BG};border-left:3px solid ${CONFIG.TEAL};border-radius:4px;padding:20px 24px;margin:0 0 24px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:5px 0;color:#5A8080;width:140px;">Organization</td><td style="padding:5px 0;font-weight:600;">${orgName}</td></tr>
        <tr><td style="padding:5px 0;color:#5A8080;">Focus Area</td><td style="padding:5px 0;">${orgType}</td></tr>
        <tr><td style="padding:5px 0;color:#5A8080;">Grant Amount</td><td style="padding:5px 0;font-weight:700;color:${CONFIG.TEAL};font-size:16px;">${fmtAmt(amount)}</td></tr>
        <tr><td style="padding:5px 0;color:#5A8080;">Check Date</td><td style="padding:5px 0;">${fmtDate(checkDate)}</td></tr>
        <tr><td style="padding:5px 0;color:#5A8080;">Check #</td><td style="padding:5px 0;font-family:monospace;">${checkNum}</td></tr>
        ${notes ? `<tr><td style="padding:5px 0;color:#5A8080;">Notes</td><td style="padding:5px 0;">${notes}</td></tr>` : ""}
      </table>
    </div>

    <p style="font-size:15px;line-height:1.6;margin:0 0 24px;">
      Thank you for championing this organization. Your recommendation helps make our
      family's giving meaningful and intentional.
    </p>

    <div style="text-align:center;margin:28px 0;">
      <a href="${CONFIG.DASHBOARD_URL}"
         style="background:${CONFIG.TEAL};color:#fff;text-decoration:none;padding:13px 28px;border-radius:6px;font-size:14px;font-weight:600;display:inline-block;letter-spacing:0.03em;">
        View ${year} Grant History ->
      </a>
    </div>

    <p style="font-size:12px;color:#5A8080;line-height:1.6;border-top:1px solid #D0E8E8;padding-top:20px;margin-top:28px;">
      The dashboard shows full grant history by year, organization, and focus area.
      Bookmark the link above for a live view anytime.<br><br>
      ${CONFIG.FOUNDATION_NAME} &middot; Confidential &middot; For family use only
    </p>
  </div>
</body></html>`;

  MailApp.sendEmail({ to: email, cc: CONFIG.ADMIN_EMAIL, subject, htmlBody });
}

// --- INCOMING DONATION --------------------------------------------------------
function handleIncomingDonation_(donorName, donorAmount, requesterEmail, requesterName) {
  const year   = new Date().getFullYear();
  const fmtAmt = n => `$${Number(n).toLocaleString()}`;
  const today  = new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let donSheet = ss.getSheetByName("Donations Received");
  if (!donSheet) {
    donSheet = ss.insertSheet("Donations Received");
    donSheet.appendRow(["Date", "Donor Name", "Amount", "Year", "Receipt Sent", "Logged By"]);
  }
  donSheet.appendRow([new Date(), donorName, donorAmount, year, "Yes", requesterName]);

  const subject  = `[${CONFIG.FOUNDATION_NAME}] Donation Receipt - ${donorName} - ${fmtAmt(donorAmount)}`;
  const htmlBody = `
<!DOCTYPE html><html><head><meta charset="UTF-8"></head>
<body style="font-family:Georgia,serif;color:#111D1D;max-width:560px;margin:0 auto;padding:0;">

  <div style="background:${CONFIG.TEAL};color:#fff;padding:32px 36px 28px;">
    <div style="font-size:11px;letter-spacing:0.18em;text-transform:uppercase;color:${CONFIG.TEAL_LIGHT};margin-bottom:6px;">Official Donation Receipt</div>
    <h1 style="margin:0;font-size:26px;font-weight:700;">${CONFIG.FOUNDATION_NAME}</h1>
    <div style="font-size:12px;color:${CONFIG.TEAL_LIGHT};margin-top:4px;">EIN: ${CONFIG.FOUNDATION_EIN} &middot; 501(c)(3) Organization</div>
  </div>

  <div style="padding:32px 36px;">
    <p style="font-size:15px;line-height:1.6;margin:0 0 20px;">Dear ${donorName},</p>
    <p style="font-size:15px;line-height:1.6;margin:0 0 24px;">
      Thank you for your generous contribution to the ${CONFIG.FOUNDATION_NAME}.
      This letter serves as your official receipt for tax purposes.
    </p>

    <div style="background:${CONFIG.TEAL_BG};border-left:3px solid #C8A020;border-radius:4px;padding:20px 24px;margin:0 0 24px;">
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <tr><td style="padding:5px 0;color:#5A8080;width:160px;">Donor Name</td><td style="padding:5px 0;font-weight:600;">${donorName}</td></tr>
        <tr><td style="padding:5px 0;color:#5A8080;">Organization</td><td style="padding:5px 0;font-weight:600;">${CONFIG.FOUNDATION_NAME}</td></tr>
        <tr><td style="padding:5px 0;color:#5A8080;">Gift Amount</td><td style="padding:5px 0;font-weight:700;color:${CONFIG.TEAL};font-size:16px;">${fmtAmt(donorAmount)}</td></tr>
        <tr><td style="padding:5px 0;color:#5A8080;">Date of Gift</td><td style="padding:5px 0;">${today}</td></tr>
        <tr><td style="padding:5px 0;color:#5A8080;">Tax Year</td><td style="padding:5px 0;">${year}</td></tr>
      </table>
    </div>

    <p style="font-size:14px;line-height:1.6;color:#3A6060;margin:0 0 20px;">
      The ${CONFIG.FOUNDATION_NAME} is a 501(c)(3) tax-exempt organization. No goods or services
      were provided in exchange for this contribution. Please retain this letter for your tax records.
    </p>

    <p style="font-size:14px;color:#5A8080;font-style:italic;border-top:1px solid #D0E8E8;padding-top:20px;margin-top:24px;">
      Your support makes our family's philanthropic mission possible.
      We are deeply grateful for your generosity.
    </p>
  </div>
</body></html>`;

  MailApp.sendEmail({ to: requesterEmail, cc: CONFIG.ADMIN_EMAIL, subject, htmlBody });
}

// --- HELPERS ------------------------------------------------------------------
function addNewOrg_(orgName, orgType) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let orgSheet = ss.getSheetByName(CONFIG.ORG_SHEET_NAME);
  if (!orgSheet) {
    orgSheet = ss.insertSheet(CONFIG.ORG_SHEET_NAME);
    orgSheet.appendRow(["Organization Name", "Type", "Date First Funded", "Notes"]);
  }
  const existing = orgSheet.getDataRange().getValues().map(r => r[0].toString().toLowerCase());
  if (!existing.includes(orgName.toLowerCase())) {
    orgSheet.appendRow([orgName, orgType, new Date(), ""]);
  }
}

// --- TEST FUNCTIONS -----------------------------------------------------------
function testCompletionEmail() {
  sendCompletionEmail_("Carlie", CONFIG.ADMIN_EMAIL, "CASA of McHenry County", "Children & Youth", 25000, new Date(), "5021", "General operating support");
  Logger.log("Test sent to " + CONFIG.ADMIN_EMAIL);
}
function testDonationReceipt() {
  handleIncomingDonation_("Test Donor", 10000, CONFIG.ADMIN_EMAIL, "Carlie");
  Logger.log("Receipt sent to " + CONFIG.ADMIN_EMAIL);
}
