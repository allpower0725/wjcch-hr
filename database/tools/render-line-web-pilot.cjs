const { readFileSync } = require("node:fs")
const { join } = require("node:path")
const { rosterWorkspaceQuery } = require("../../web/lib/roster-queries.ts")

function lineWebPilotFunctions(subjectFingerprint) {
  if (!/^[a-f0-9]{64}$/.test(subjectFingerprint)) throw new Error("Missing LINE pilot subject fingerprint")

  const identity = "hr.line_login_identity($1::bytea)"
  if (!rosterWorkspaceQuery.includes(identity)) throw new Error("Roster workspace identity query changed")
  const roster = rosterWorkspaceQuery
    .replace(identity, "hr.line_web_pilot_identity($1::bytea)")
    .replace(/\$([234])\b/g, (_, index) => ({ 2: "'P271'", 3: "p_unit_id", 4: "1" })[index])
    .trim()
  return readFileSync(join(__dirname, "line-web-pilot-functions.sql"), "utf8")
    .replaceAll("__PILOT_SUBJECT_SHA256__", subjectFingerprint)
    .replace("__PILOT_ROSTER_QUERY__", () => roster)
}

module.exports = { lineWebPilotFunctions }
