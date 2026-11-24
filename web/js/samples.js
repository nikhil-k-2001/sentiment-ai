// Curated example inputs. These are only *inputs*; every result shown in the
// app comes from the model.
export const FEATURED = [
  { name: "Glowing review", text: "Absolutely love this! The support team was incredibly helpful and fixed my issue in minutes. Thank you so much — best experience I've had in ages." },
  { name: "Complaint", text: "Worst service ever. My order was delayed three times, nobody answered the phone and I'm still waiting for a refund. Completely unacceptable." },
  { name: "Neutral question", text: "Does the premium plan include priority boarding, or is that a separate add-on? Planning a trip for next month." },
  { name: "Mixed feedback", text: "The staff were friendly and the seats were comfortable, but the delay was frustrating and the food was cold." },
  { name: "Social post", text: "Just landed in Denver ✈️ smooth flight and the crew was awesome! #travel" },
];

export const POOL = [
  "Thanks for the quick response, the issue is resolved and everything works perfectly now!",
  "I've been on hold for over an hour. This is ridiculous and I want to cancel my account.",
  "What time does the store open on Sundays?",
  "Great value for money. Setup took five minutes and the battery life is excellent.",
  "The app keeps crashing every time I try to check out. Really disappointed.",
  "My package was supposed to arrive yesterday but tracking hasn't updated since Monday.",
  "Can I change my seat after I've already checked in online?",
  "Honestly the best customer service I've ever received. Kudos to Maria at the front desk!",
  "They lost my luggage and nobody seems to care. Terrible experience from start to finish.",
  "The new update changed the layout of the settings page.",
  "Super comfortable shoes, I wear them every day. Would definitely buy again.",
  "Flight was cancelled with no explanation and the rebooking fee is outrageous.",
  "Is there a student discount available for the annual subscription?",
  "Loved the hotel, the room was spotless and the view was amazing.",
  "The product description said waterproof. It is not. Returning it.",
  "Our meeting has been moved to 3pm on Thursday.",
  "Wow, check-in took less than two minutes. Impressed!",
  "Rude staff, dirty tables, and we waited 40 minutes for cold food. Never again.",
  "I received the replacement part today, will install it this weekend.",
  "Big thanks to the crew on flight 221 — they made my kid's first trip so special.",
  "Customer support promised a callback and never called. Still broken.",
  "Please send me the invoice for last month's order.",
  "Fantastic course! The instructor explains everything clearly and the examples are practical.",
  "The checkout page charged me twice. I need this fixed today.",
];

let last = -1;
export function randomSample() {
  let i;
  do { i = Math.floor(Math.random() * POOL.length); } while (i === last && POOL.length > 1);
  last = i;
  return POOL[i];
}
