// Returns true if the text is a real timezone name like "Asia/Kolkata".
function isValidTimeZone(timezone) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

module.exports = { isValidTimeZone };
