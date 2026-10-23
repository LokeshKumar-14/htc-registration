export const API_BASE_URL = "";
export const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbz78QFlP6HFPdyVmmdyQw9hkKyettcfqSLPj63Lm6BMFA5RZ2MuurlVLwoEaD8jw7TN/exec";

export const BRANCHES = [
  "Computer Engineering",
  "Information Technology",
  "Electronics and Communication Engineering",
  "Electrical Engineering",
  "Mechanical Engineering",
  "Civil Engineering",
  "Industrial Engineering",
  "Other",
];

export const EVENT_LINKS = [
  { name: "Gully Cricket", url: "https://chat.whatsapp.com/EmG0V4RLzsdKODSgQMeB0G?s=cl&p=a&mlu=4&ilr=4" },
  { name: "Gully Football", url: "https://chat.whatsapp.com/C116ueyemsL74eZUlwKUQi?s=cl&p=a&mlu=4&ilr=4" },
  { name: "Cyclothon", url: "https://chat.whatsapp.com/LhBu3ErdUrh7HJCHUTBmfk?s=cl&p=a&mlu=4&ilr=4" },
  { name: "Treasure Hunt", url: "https://chat.whatsapp.com/Gr3A5WJJotZGD9knnw1tBI?s=cl&p=a&mlu=4&ilr=4" },
];

export const EVENTS = [
  {
    key: "cricket", title: "Gully Cricket", prize: "₹1,000", date: "31 October",
    time: "9:00 AM – 10:30 AM", venue: "AE Lawns", teamSize: 5,
    description: "Get your team ready for an exciting game of Gully Cricket! Bring your teammates, show your skills, and compete for the win.",
    contacts: [
      { name: "Ayush Bansal", phone: "+91 89552 36226" },
      { name: "Pawan", phone: "+91 70242 19084" },
    ],
  },
  {
    key: "football", title: "Gully Football", prize: "₹500", date: "1 November",
    time: "10:00 AM – 1:30 PM", venue: "Behind LHC", teamSize: 5,
    description: "Love football? Bring your teammates and enjoy an energetic game of Gully Football. Compete with other students and show your teamwork.",
    contacts: [
      { name: "Urmil", phone: "9004283146" },
      { name: "Kshitiz", phone: "98912 35789" },
    ],
  },
  {
    key: "cyclothon", title: "Cyclothon", prize: "₹500", date: "1 November",
    time: "6:00 AM – 11:30 AM", venue: "Market", individual: true,
    description: "Join Cyclothon, challenge yourself, and enjoy an exciting cycling race with fellow students.",
    contacts: [
      { name: "Kunal Garg", phone: "+91 831 818 3998" },
      { name: "Mithil Adapa", phone: "+91 90320 49299" },
    ],
  },
  {
    key: "treasure", title: "Treasure Hunt", date: "25 October — Preliminary Round",
    time: "10:00 AM", venue: "LHC 102", teamSize: 4,
    final: "Final: 31 October · 9:30 AM – 2:30 PM · Campus-wide designated locations",
    description: "Take part in an exciting campus-wide Treasure Hunt! Begin with the MCQ-based preliminary round. Selected teams will participate in the final round, explore designated campus locations, and complete the challenges. Follow the instructions communicated by the organizers and take the required group photographs at the designated locations.",
    contacts: [
      { name: "Suyash", phone: "+91 96540 04537" },
      { name: "Shruti", phone: "+91 90349 26895" },
      { name: "Nitin Chhillar", phone: "+91 83970 29501" },
    ],
  },
];
