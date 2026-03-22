const categories = ["red", "blue", "green"];

const CATEGORY_LABEL = {
  red: "Detection & Logging",
  blue: "Triage & Diagnosis",
  green: "Resolution & Closure",
};

const SPACES = Array.from({ length: 24 }, (_, index) => {
  const cycle = index % 4;
  if (cycle === 0) return "red";
  if (cycle === 1) return "blue";
  if (cycle === 2) return "green";
  return "neutral";
});

const DEFAULT_QUESTION_DECK = [
  {
    category: "red",
    prompt: "What should happen first when an alert triggers?",
    options: [
      "Ignore it until users report impact",
      "Log and create or update an incident ticket",
      "Close monitoring to reduce noise",
      "Jump directly to closure",
    ],
    correctOptionIndex: 1,
  },
  {
    category: "red",
    prompt: "Give one common source of incidents.",
    options: [
      "Monitoring alert or user report",
      "Holiday calendar entry",
      "Coffee machine notification",
      "Office parking shortage",
    ],
    correctOptionIndex: 0,
  },
  {
    category: "red",
    prompt: "What is the purpose of incident classification?",
    options: [
      "To make incident tickets longer",
      "To route and prioritize incidents correctly",
      "To remove SLA commitments",
      "To skip communication",
    ],
    correctOptionIndex: 1,
  },
  {
    category: "blue",
    prompt: "What two factors determine incident priority?",
    options: [
      "Age and team size",
      "Impact and urgency",
      "Shift timing and weather",
      "Budget and hardware brand",
    ],
    correctOptionIndex: 1,
  },
  {
    category: "blue",
    prompt: "When should an incident be escalated?",
    options: [
      "Only after closure",
      "When SLA risk is high or expertise is missing",
      "Never",
      "Only if no ticket exists",
    ],
    correctOptionIndex: 1,
  },
  {
    category: "blue",
    prompt: "Why communicate during triage?",
    options: [
      "To create extra approvals",
      "To align responders and keep stakeholders informed",
      "To delay recovery",
      "To hide incident impact",
    ],
    correctOptionIndex: 1,
  },
  {
    category: "green",
    prompt: "What is a workaround in incident management?",
    options: [
      "A final permanent fix",
      "A temporary action to restore service quickly",
      "A postmortem template",
      "A tool for deleting logs",
    ],
    correctOptionIndex: 1,
  },
  {
    category: "green",
    prompt: "What should be verified before closure?",
    options: [
      "Service restored, fix validated, and users confirmed",
      "Only ticket title updated",
      "Only manager informed",
      "No verification needed",
    ],
    correctOptionIndex: 0,
  },
  {
    category: "green",
    prompt: "Why capture lessons learned?",
    options: [
      "To prevent recurrence and improve response process",
      "To reduce monitoring visibility",
      "To avoid documenting root causes",
      "To skip closure checks",
    ],
    correctOptionIndex: 0,
  },
];

const TRAP_ACTIVITIES = [
  "Name 3 actions to stabilize an incident in 20 seconds.",
  "Give one escalation reason and one communication channel.",
  "State a quick workaround and one verification step.",
  "List impact, urgency, and one SLA-related action.",
  "Name one likely root cause and one containment action.",
  "Give a closure check and one lesson learned item.",
];

const ANSWER_REVEAL_MS = 3000;
const QUESTION_TIMEOUT_MS = 45000;

const legacyDemoTeamNames = new Set([
  "team alpha",
  "team bravo",
  "team charlie",
  "team delta",
]);

const legacyDemoPlayerNames = new Set([
  "nora",
  "ibrahim",
  "lea",
  "mateo",
  "chen",
  "sana",
  "ava",
  "rami",
  "noah",
  "zoe",
  "karim",
  "mina",
]);

module.exports = {
  categories,
  CATEGORY_LABEL,
  SPACES,
  DEFAULT_QUESTION_DECK,
  TRAP_ACTIVITIES,
  ANSWER_REVEAL_MS,
  QUESTION_TIMEOUT_MS,
  legacyDemoTeamNames,
  legacyDemoPlayerNames,
};
