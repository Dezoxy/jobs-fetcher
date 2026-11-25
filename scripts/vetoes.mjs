// The deterministic candidate vetoes, shared by every collection path.
//
// Extracted from fetch-sources.mjs on 2026-08-12 so the browser-collected
// LinkedIn rows can run the same rules instead of an agent re-applying them
// from prose — docs/refresh-task.md used to instruct exactly that, by hand.
// Two copies of a regex calibrated against 764 hand-judged rows would drift
// on the first edit, and silently: nothing compares them.
//
// judge*() returns "keep" | "<reason>", where a reason reads
// "<counter>:<detail>" and <counter> is one of location/language/title. The
// callers bucket their counters by the prefix and keep the whole string as
// the audit trail in droppedRows.

// Deterministic pre-filters (added 2026-07-29). Policy source:
// employee-cv/profile/preferences.md — Budapest metro only, German-language
// roles explicitly excluded. These rows were being re-dropped by the LLM
// fit filter on every run; dropping them here costs nothing and cannot
// misjudge, because the rule is mechanical.
//
// Location: data-category6 carries up to two location TAGS, not a
// "<megye> → <város>" hierarchy — that reading was the original mistake here.
// Debrecen appears under both "Hajdú-Bihar megye, Debrecen" (a genuinely
// local employer: OZEKI, DYNTELL, Diehl) and "Pest megye, Debrecen" (81 of
// 88 such rows are Deutsche Telekom TSI: a Budapest-registered company
// advertising a Debrecen post in both places). So the megye segment is not
// "unreliable" — it is a second, independent tag, and only the city segment
// says where the work actually is. Trusting it is still correct; what was
// wrong was calling the other segment noise.
// No city segment ("Pest megye", "Országos", empty) → keep, the ad may be
// countrywide or remote-capable.
// Trade-off, accepted: a provincial ad that would allow remote work is
// dropped too — the browser-era fit filter applied the same rule.
export const METRO_CITIES = new Set([
  "budapest", "budaörs", "érd", "vecsés", "dunaharaszti", "biatorbágy",
  "törökbálint", "dunakeszi", "szentendre", "gödöllő", "vác",
  "szigetszentmiklós", "gyál", "fót", "monor",
]);
export const FOREIGN_LOC = /németország|ausztria|svájc|szlovákia|románia|deutschland/i;
// Gendered recruitment tags — (m/w/d), (m/f/d), (gn), (m/w/x) and friends —
// are German-market ads whatever language the title is in. The original two
// hard-coded variants missed (m/f/d) and (gn): 15 such rows reached the list
// and the user hid all 15 (tracker export, 2026-08-07). Any 2-3 letter
// combination of m/w/f/d/x/gn in parens counts, plus bare (gn).
export const GERMAN_ROLE = /german|német nyelv|\((?:m|w|f|d|x|gn)\s*[/|]\s*(?:m|w|f|d|x|gn)(?:\s*[/|]\s*(?:m|w|f|d|x|gn))?\)|\(gn\)/i;

// Gem gate — REMOVED 2026-08-26, measured, after four weeks live.
//
// It was added 2026-07-29 ("bővítsd hátha"): a provincial city normally means
// drop, but a title in the priority families (architect, devops/cloud,
// security/IAM, AI, SRE/platform) was kept and flagged "vidéki" instead, on
// the theory that those are the ads where remote/hybrid or a relocation-worthy
// offer is plausible. The theory assumed provincial priority-role ads are rare
// exceptions. They are not: one employer, Deutsche Telekom TSI Debrecen, posts
// nothing BUT cloud/devops/security/AI titles, so the exception became the rule.
//
// The ledger, on the 2026-08-24 fetch and the 2026-08-26 tracker (900 verdicts):
//   54 provincial ads admitted per run
//   43 of them re-judged and re-dropped by the merge agent, every six hours
//   11 reached jobs.json
//    8 the user then marked "Nem érdekel" by hand
//    3 still untouched — all Deutsche Telekom Debrecen, and the reason this
//      rule is being removed
//    0 ever accepted
// Wider check across all 794 rows: 14 mention a provincial city, 12 are
// "Nem érdekel", and the 2 that are not are those same untouched DT rows.
//
// A gate that has never once paid out, while generating hand-triage work every
// six hours and paying an LLM to re-drop the same 43 ads, is not a safety net.
// Provincial now means drop, full stop — the rule preferences.md always stated.
//
// If it ever comes back: it must be keyed on something the employer cannot
// repeat 81 times (an explicit remote/hybrid marker in the ad body), not on the
// role title, which is exactly what a large provincial employer mass-produces.

// Aggregator veto (added 2026-08-29). Not a title rule and not a location
// rule — the only thing wrong with these rows is who posted them.
//
// wherewework.hu posts CV-harvesting listings that carry no employer and no
// job. All nine in jobs.json on 2026-08-29 run the identical template body
// ("Töltse fel egyszer az önéletrajzát... mi segítünk összekapcsolni valódi
// álláslehetőségekkel"), and the titles are keyword permutations rather than
// roles: Platformmérnök (Azure), Platformmérnök (AWS), Platformmérnök
// (Ansible), DevOps mérnök, DevOps mérnök (Docker), Infrastruktúra-mérnök
// (Azure), Infrastruktúra-mérnök (AWS), Vezető DevOps mérnök,
// Megoldásarchitekt. Every one of those titles hits CORE_ANCHOR, so the title
// vetoes forward them all straight to the LLM fit filter, which pays to
// re-read the same template every six hours.
//
// They also sort high, which is the part that costs triage time rather than
// tokens: the ad body quotes a market salary range ("1 480 000 - 2 620 000
// HUF") instead of an offer, so the salary estimate lands in the top band and
// the row opens near the head of the mid-desc list. Four of them were sitting
// in the untriaged inbox on 2026-08-29.
//
// Deliberately NOT a general "recruiter" or "job board" rule. Jobgether
// reposts genuine ads under its own name — two rows on 2026-08-29, and the
// 19:16 run report picked one (Infrastructure Engineer - Vulnerability,
// DevOps & Automation) as the day's best find. Reposter is not aggregator;
// what disqualifies wherewework is that there is no job behind the posting.
// Add a name here only with rows in hand showing the same template pattern.
//
// Anchored at the start so a legitimate employer whose name merely contains
// the word is unaffected.
export const AGGREGATOR_COMPANY = /^\s*wherewework(\.hu)?\b/i;

// returns the veto reason, or null when the poster is not a known aggregator
export function companyVeto(company) {
  return AGGREGATOR_COMPANY.test(company || "") ? "aggregator" : null;
}

// Title vetoes (added 2026-08-07). Calibrated against the 764 rows the user
// had judged on the dashboard by then: this exact ruleset mechanically drops
// 109 of them, 107 correctly hidden, 2 borderline false drops (98%). Two
// tiers, because "consultant" is 89% noise yet "IAM Consultant" was kept:
//   - HARD fires regardless of anything else (junior; gender tags are
//     handled by GERMAN_ROLE above): 100% hide rate, no rescue needed.
//   - SOFT fires only when the title carries no core-domain anchor — the
//     anchor doesn't accept the ad, it only forwards it to the LLM fit
//     filter instead of killing it here. SAP is soft too: "Platform
//     Engineer (SAP BTP)" and "Rendszermérnök (SAP bázis)" were kept while
//     plain "SAP Consultant" never was.
// Business Analyst titles are deliberately NOT here: that family is demoted
// (sorted last, kept out of the digest), not dropped — see public/app.js.
export const VETO_JUNIOR = /\bjunior\b|\bintern(ship)?\b|gyakornok|\btrainee\b|\bgraduate\b|pályakezdő/i;
export const VETO_SOFT = {
  sap: /\bsap\b|s\/4hana|successfactors|\bariba\b|\babap\b/i,
  consultant: /\bconsultant\b|\btanácsadó\b|\badvisor\b/i,
  developer: /\bdeveloper\b|fejlesztő|software engineer|\bprogramozó\b/i,
  vendor: /servicenow|salesforce|veeva|genesys|dynamics 365|\bd365\b|sharepoint/i,
};
export const CORE_ANCHOR = /security|biztonság|cyber|\biam\b|identity|devops|\bsre\b|site reliability|platform engineer|cloud engineer|cloud architect|infrastruct|infrastruktúr|rendszermérnök|rendszergazda|üzemeltet|network|hálózat|kubernetes|openshift|\bai\b|\bml\b|mlops|observability|linux|automation|automatizál/i;

// returns the veto reason, or null to let the row through to the fit filter
export function titleVeto(role) {
  const t = role || "";
  if (VETO_JUNIOR.test(t)) return "junior";
  if (CORE_ANCHOR.test(t)) return null;
  for (const [reason, re] of Object.entries(VETO_SOFT)) if (re.test(t)) return reason;
  return null;
}

// returns: "keep" | "<drop reason>"
export function judgeProfession(role, loc) {
  if (GERMAN_ROLE.test(role || "")) return "language:german-or-gender-tag";
  const veto = titleVeto(role);
  if (veto) return `title:${veto}`;
  if (FOREIGN_LOC.test(loc || "")) return "location:foreign";
  const city = ((loc || "").split(",")[1] || "").trim().toLowerCase();
  if (!city || METRO_CITIES.has(city)) return "keep";
  return "location:provincial";
}

const HU_COUNTRY = /^(hungary|magyarország)$/i;

// LinkedIn location veto (added 2026-09-07). The cards have carried a
// location since 2026-08-29 (scripts/fetch-linkedin.mjs writes it from
// job-search-card__location), but nothing read it for nine days: the
// 2026-09-05 and 2026-09-07 run notes both record provincial ads reaching the
// merge agent, which rejected them by hand — Infineon Cegléd, Gentherm
// Pilisszentiván, and HARMAN Székesfehérvár, the last of which was the ONLY
// row to survive the filters that run.
//
// The rule is judgeProfession's, but the parsing cannot be shared, and this is
// the trap: LinkedIn writes "<city>, <region>, <country>" — city FIRST —
// while Profession's data-category6 is "<megye>, <város>", which is why
// judgeProfession reads split(",")[1]. Applying that index here would read the
// county as the city and drop nearly everything.
//
// Foreign is detected from the LAST segment rather than by name, because
// FOREIGN_LOC only knows the Hungarian spellings (németország, ausztria) and
// would never match LinkedIn's English "Germany". In the multi-segment form
// the last segment is always the country, so "not Hungary" is the whole test.
//
// Single-segment values — "Hungary", "Budapest Metropolitan Area", and
// whatever else LinkedIn coins — return null on purpose. They carry no city
// to judge, exactly like Profession's empty-city case, and this file's
// standing rule is that a value it cannot read never invents a drop. Such a
// row goes to the LLM fit filter, which is where an unreadable location
// belongs.
//
// returns the veto reason, or null when the location is acceptable or unreadable
export function locationVetoLinkedIn(loc) {
  const s = (loc || "").trim();
  if (!s) return null;
  if (FOREIGN_LOC.test(s)) return "foreign";
  const parts = s.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length < 2) return null; // no city segment — keep, never guess
  if (!HU_COUNTRY.test(parts[parts.length - 1])) return "foreign";
  const city = parts[0].toLowerCase();
  // "Budapest Metropolitan Area, Hungary" is a Budapest row wearing a label.
  if (METRO_CITIES.has(city) || /^budapest\b/.test(city)) return null;
  return "provincial";
}

// `company` and `loc` are both optional: callers that do not have them get the
// earlier behaviour rather than a crash, and an absent value can only ever mean
// "nothing to veto on" — it never invents a drop.
export function judgeLinkedIn(role, company, loc) {
  if (GERMAN_ROLE.test(role || "")) return "language:german-or-gender-tag";
  // Before the title vetoes: these titles all hit CORE_ANCHOR, so a
  // title-first order would let every one of them through.
  const poster = companyVeto(company);
  if (poster) return `company:${poster}`;
  const veto = titleVeto(role);
  if (veto) return `title:${veto}`;
  // Last, matching judgeProfession's order, so every row dropped before this
  // change keeps the reason it already had and only survivors reach the new rule.
  const place = locationVetoLinkedIn(loc);
  if (place) return `location:${place}`;
  return "keep";
}
