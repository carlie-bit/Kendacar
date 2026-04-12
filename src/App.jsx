import { useState, useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer,
  PieChart, Pie, Cell, Legend, LineChart, Line, CartesianGrid, Area, AreaChart
} from "recharts";

// =============================================================================
//  REAL GRANT DATA - Kendacar Foundation 2001-2025
// =============================================================================

const ORG_CATEGORIES = {
  "Casa of McHenry County": "Children & Youth",
  "Big Brothers Big Sisters of McHenry County": "Children & Youth",
  "Big Brothers Big Sisters of Indian River": "Children & Youth",
  "Gifford Youth Achievement Center": "Children & Youth",
  "Holiday Heroes Foundation": "Children & Youth",
  "Special Olympics": "Children & Youth",
  "Youth Service Bureau": "Children & Youth",
  "Canaryville Little League": "Children & Youth",
  "Project Linus": "Children & Youth",
  "Miss B Learning Bsse": "Children & Youth",
  "Alexander Leigh Center for Autism": "Children & Youth",
  "Northern Illinois Center of Autism": "Children & Youth",
  "Parla": "Domestic Violence",
  "Huron County Coalition Against Domestic Violence": "Domestic Violence",
  "Home of the Sparrow": "Domestic Violence",
  "Northern Illinois Food Bank": "Food & Hunger",
  "Crystal Lake Food Pantry": "Food & Hunger",
  "Food Pantry Indian River County": "Food & Hunger",
  "Treasure Coast Food Bank": "Food & Hunger",
  "Harvest Food and Outreach": "Food & Hunger",
  "Care and Share": "Food & Hunger",
  "Salvation Army": "Food & Hunger",
  "Rockford Rescue Mission": "Food & Hunger",
  "Cleveland Clinic - Indian River": "Healthcare",
  "Indian River Medical Center": "Healthcare",
  "Indian River Hospital Foundation": "Healthcare",
  "Scheurer Hospital": "Healthcare",
  "VNA and Hospice Foundation": "Healthcare",
  "Alzheimer's Association": "Healthcare",
  "Juvenile Diabetes Research Foundation": "Healthcare",
  "The Wellness Place": "Healthcare",
  "Senior Resource Associaiton": "Healthcare",
  "Riverside Theatre": "Arts & Culture",
  "Vero Beach Museum of Art": "Arts & Culture",
  "Fort Pierce Magnet School of the arts": "Arts & Culture",
  "The Learning Alliance": "Education",
  "The Learning Tree of Crystal Lake": "Education",
  "The Neighborhood Academy": "Education",
  "District 47 Giftcard Pgm": "Education",
  "Vero Beach Elementary School": "Education",
  "Educational Foundation of Indian River": "Education",
  "St. John's Northwestern Military Academy": "Education",
  "Impact 100": "Education",
  "MCC Foundation": "Education",
  "Hoover Institution": "Education",
  "CASA of McHenry County": "Children & Youth",
  "Habitat for Humanity IRC": "Community Development",
  "Village of Port Austin": "Community Development",
  "Max McGraw Wildlife Foundation": "Environment & Wildlife",
  "Enviromental Learning Center": "Environment & Wildlife",
  "Indian River Land Trust": "Environment & Wildlife",
  "Treasure Coast Manatee Foundation": "Environment & Wildlife",
  "MCKEE Botanical Garden": "Environment & Wildlife",
  "Indian River Habitat for Humanity ": "Community Development",
  "Indian River Habitat for Humanity": "Community Development",
  "Huron Community Foundation": "Community Development",
  "Huron County Community Foundation": "Community Development",
  "Huron Development Commission": "Community Development",
  "Musana Community Development Org": "Community Development",
  "Indian River Community": "Community Development",
  "Port Austin Fire Department": "Community Development",
  "Port Austin Good Fellows": "Community Development",
  "The Hope for Families Center": "Community & Social Services",
  "Daisie Bridgewater Hope Center": "Community & Social Services",
  "St. Luke N.E.W. Life Center": "Community & Social Services",
  "Options and Advocacy for McHenry County ": "Community & Social Services",
  "Options and Advocacy for McHenry County": "Community & Social Services",
  "Indian River County United Against Poverty": "Community & Social Services",
  "PADS First Congregational Church / McHenry County PADS": "Community & Social Services",
  "American Red Cross": "Community & Social Services",
  "Jaycee's": "Community & Social Services",
  "Junior Priscilla Womens CLub": "Community & Social Services",
  "Port Austin United  Protestant Church": "Religious",
  "United Protestant Church (Grayslake)": "Religious",
  "Port Austin United Protestant Church": "Religious",
};

const GRANTS = [
  { id: 176, year: 2026, org: "CASA of McHenry County", amount: 32855 },
  { id: 177, year: 2026, org: "Habitat for Humanity IRC", amount: 10000 },
  { id: 178, year: 2026, org: "The Hope for Families Center", amount: 10000 },
  { id: 179, year: 2026, org: "Village of Port Austin", amount: 62500 },
  { id: 180, year: 2026, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 181, year: 2025, org: "Northern Illinois Food Bank", amount: 10000 },
  { id: 182, year: 2025, org: "Hoover Institution", amount: 10000 },
  { id: 1, year: 2025, org: "Big Brothers Big Sisters of McHenry County", amount: 50000 },
  { id: 2, year: 2025, org: "Parla", amount: 40000 },
  { id: 3, year: 2025, org: "Casa of McHenry County", amount: 25000 },
  { id: 4, year: 2025, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 5, year: 2025, org: "The Learning Alliance", amount: 10000 },
  { id: 6, year: 2025, org: "Max McGraw Wildlife Foundation", amount: 7500 },
  { id: 7, year: 2024, org: "Parla", amount: 210000 },
  { id: 8, year: 2024, org: "Cleveland Clinic - Indian River", amount: 100000 },
  { id: 9, year: 2024, org: "Port Austin Fire Department", amount: 88000 },
  { id: 10, year: 2024, org: "Big Brothers Big Sisters of McHenry County", amount: 50000 },
  { id: 11, year: 2024, org: "The Hope for Families Center", amount: 20000 },
  { id: 12, year: 2024, org: "District 47 Giftcard Pgm", amount: 12000 },
  { id: 13, year: 2024, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 14, year: 2024, org: "Northern Illinois Food Bank", amount: 10000 },
  { id: 15, year: 2024, org: "Max McGraw Wildlife Foundation", amount: 7500 },
  { id: 16, year: 2023, org: "Treasure Coast Food Bank", amount: 100000 },
  { id: 17, year: 2023, org: "District 47 Giftcard Pgm", amount: 50000 },
  { id: 18, year: 2023, org: "Big Brothers Big Sisters of McHenry County", amount: 50000 },
  { id: 19, year: 2023, org: "Indian River Habitat for Humanity", amount: 20000 },
  { id: 20, year: 2023, org: "Casa of McHenry County", amount: 20000 },
  { id: 21, year: 2023, org: "The Learning Alliance", amount: 20000 },
  { id: 22, year: 2023, org: "Big Brothers Big Sisters of Indian River", amount: 10000 },
  { id: 23, year: 2023, org: "Max McGraw Wildlife Foundation", amount: 7500 },
  { id: 24, year: 2023, org: "The Hope for Families Center", amount: 7000 },
  { id: 25, year: 2023, org: "Northern Illinois Food Bank", amount: 5000 },
  { id: 26, year: 2022, org: "Senior Resource Associaiton", amount: 50000 },
  { id: 27, year: 2022, org: "Crystal Lake Food Pantry", amount: 40000 },
  { id: 28, year: 2022, org: "District 47 Giftcard Pgm", amount: 22500 },
  { id: 29, year: 2022, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 30, year: 2022, org: "Max McGraw Wildlife Foundation", amount: 7500 },
  { id: 31, year: 2021, org: "Max McGraw Wildlife Foundation", amount: 20500 },
  { id: 32, year: 2021, org: "Salvation Army", amount: 20000 },
  { id: 33, year: 2021, org: "The Learning Alliance", amount: 20000 },
  { id: 34, year: 2021, org: "Indian River Habitat for Humanity", amount: 15000 },
  { id: 35, year: 2021, org: "Big Brothers Big Sisters of Indian River", amount: 8000 },
  { id: 36, year: 2021, org: "Impact 100", amount: 8000 },
  { id: 37, year: 2021, org: "Riverside Theatre", amount: 5000 },
  { id: 38, year: 2021, org: "Northern Illinois Food Bank", amount: 5000 },
  { id: 39, year: 2021, org: "Junior Priscilla Womens CLub", amount: 3000 },
  { id: 40, year: 2021, org: "VNA and Hospice Foundation", amount: 3000 },
  { id: 41, year: 2020, org: "District 47 Giftcard Pgm", amount: 31345 },
  { id: 42, year: 2020, org: "Crystal Lake Food Pantry", amount: 27452 },
  { id: 43, year: 2020, org: "Huron County Coalition Against Domestic Violence", amount: 25000 },
  { id: 44, year: 2020, org: "The Learning Alliance", amount: 24000 },
  { id: 45, year: 2020, org: "Indian River Habitat for Humanity", amount: 15000 },
  { id: 46, year: 2020, org: "Indian River Medical Center", amount: 15000 },
  { id: 47, year: 2020, org: "Big Brothers Big Sisters of Indian River", amount: 8500 },
  { id: 48, year: 2020, org: "Treasure Coast Food Bank", amount: 8000 },
  { id: 49, year: 2020, org: "Junior Priscilla Womens CLub", amount: 6000 },
  { id: 50, year: 2020, org: "Riverside Theatre", amount: 5000 },
  { id: 51, year: 2020, org: "Indian River County United Against Poverty", amount: 2000 },
  { id: 52, year: 2020, org: "The Hope for Families Center", amount: 2000 },
  { id: 53, year: 2020, org: "United Protestant Church (Grayslake)", amount: 2000 },
  { id: 54, year: 2020, org: "Daisie Bridgewater Hope Center", amount: 1500 },
  { id: 55, year: 2020, org: "Impact 100", amount: 1000 },
  { id: 56, year: 2020, org: "Food Pantry Indian River County", amount: 1000 },
  { id: 57, year: 2020, org: "MCKEE Botanical Garden", amount: 500 },
  { id: 58, year: 2019, org: "The Learning Alliance", amount: 11000 },
  { id: 59, year: 2019, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 60, year: 2019, org: "Casa of McHenry County", amount: 8000 },
  { id: 61, year: 2019, org: "District 47 Giftcard Pgm", amount: 6000 },
  { id: 62, year: 2019, org: "Riverside Theatre", amount: 5000 },
  { id: 63, year: 2019, org: "Big Brothers Big Sisters of Indian River", amount: 5000 },
  { id: 64, year: 2019, org: "Vero Beach Elementary School", amount: 5000 },
  { id: 65, year: 2019, org: "Educational Foundation of Indian River", amount: 3000 },
  { id: 66, year: 2019, org: "Miss B Learning Bsse", amount: 2500 },
  { id: 67, year: 2019, org: "Gifford Youth Achievement Center", amount: 2250 },
  { id: 68, year: 2019, org: "Treasure Coast Food Bank", amount: 2000 },
  { id: 69, year: 2019, org: "Huron Community Foundation", amount: 2000 },
  { id: 70, year: 2019, org: "Junior Priscilla Womens CLub", amount: 2000 },
  { id: 71, year: 2019, org: "Impact 100", amount: 1200 },
  { id: 72, year: 2019, org: "Salvation Army", amount: 802 },
  { id: 73, year: 2019, org: "Project Linus", amount: 250 },
  { id: 74, year: 2018, org: "Daisie Bridgewater Hope Center", amount: 11000 },
  { id: 75, year: 2018, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 76, year: 2018, org: "Port Austin United  Protestant Church", amount: 10000 },
  { id: 77, year: 2018, org: "The Learning Alliance", amount: 10000 },
  { id: 78, year: 2018, org: "District 47 Giftcard Pgm", amount: 9293 },
  { id: 79, year: 2018, org: "Treasure Coast Manatee Foundation", amount: 9000 },
  { id: 80, year: 2018, org: "Casa of McHenry County", amount: 7000 },
  { id: 81, year: 2018, org: "Riverside Theatre", amount: 5000 },
  { id: 82, year: 2018, org: "Big Brothers Big Sisters of Indian River", amount: 5000 },
  { id: 83, year: 2018, org: "Junior Priscilla Womens CLub", amount: 2000 },
  { id: 84, year: 2018, org: "Salvation Army", amount: 1774 },
  { id: 85, year: 2018, org: "Vero Beach Elementary School", amount: 1000 },
  { id: 86, year: 2017, org: "Indian River Medical Center", amount: 15000 },
  { id: 87, year: 2017, org: "District 47 Giftcard Pgm", amount: 10568 },
  { id: 88, year: 2017, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 89, year: 2017, org: "The Learning Alliance", amount: 10000 },
  { id: 90, year: 2017, org: "Casa of McHenry County", amount: 5000 },
  { id: 91, year: 2017, org: "Riverside Theatre", amount: 5000 },
  { id: 92, year: 2017, org: "Gifford Youth Achievement Center", amount: 3000 },
  { id: 93, year: 2017, org: "Treasure Coast Food Bank", amount: 2000 },
  { id: 94, year: 2017, org: "Options and Advocacy for McHenry County", amount: 2000 },
  { id: 95, year: 2017, org: "Holiday Heroes Foundation", amount: 2000 },
  { id: 96, year: 2017, org: "Junior Priscilla Womens CLub", amount: 2000 },
  { id: 97, year: 2017, org: "Indian River Community", amount: 1050 },
  { id: 98, year: 2017, org: "Canaryville Little League", amount: 1000 },
  { id: 99, year: 2017, org: "Daisie Bridgewater Hope Center", amount: 1000 },
  { id: 100, year: 2017, org: "Salvation Army", amount: 768 },
  { id: 101, year: 2017, org: "Indian River County United Against Poverty", amount: 500 },
  { id: 102, year: 2016, org: "Vero Beach Museum of Art", amount: 14000 },
  { id: 103, year: 2016, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 104, year: 2016, org: "The Learning Alliance", amount: 10000 },
  { id: 105, year: 2016, org: "District 47 Giftcard Pgm", amount: 6000 },
  { id: 106, year: 2016, org: "Options and Advocacy for McHenry County", amount: 5000 },
  { id: 107, year: 2016, org: "St. Luke N.E.W. Life Center", amount: 5000 },
  { id: 108, year: 2016, org: "Holiday Heroes Foundation", amount: 3500 },
  { id: 109, year: 2016, org: "Fort Pierce Magnet School of the arts", amount: 2000 },
  { id: 110, year: 2016, org: "Canaryville Little League", amount: 1500 },
  { id: 111, year: 2015, org: "Indian River Hospital Foundation", amount: 30000 },
  { id: 112, year: 2015, org: "Enviromental Learning Center", amount: 10100 },
  { id: 113, year: 2015, org: "Indian River Habitat for Humanity", amount: 10000 },
  { id: 114, year: 2015, org: "Parla", amount: 5000 },
  { id: 115, year: 2015, org: "Casa of McHenry County", amount: 5000 },
  { id: 116, year: 2015, org: "Gifford Youth Achievement Center", amount: 5000 },
  { id: 117, year: 2015, org: "Canaryville Little League", amount: 2500 },
  { id: 118, year: 2015, org: "Harvest Food and Outreach", amount: 2500 },
  { id: 119, year: 2015, org: "Treasure Coast Food Bank", amount: 2000 },
  { id: 120, year: 2014, org: "Huron County Coalition Against Domestic Violence", amount: 39750 },
  { id: 121, year: 2014, org: "Enviromental Learning Center", amount: 4900 },
  { id: 122, year: 2014, org: "Northern Illinois Center of Autism", amount: 2500 },
  { id: 123, year: 2014, org: "Casa of McHenry County", amount: 2500 },
  { id: 124, year: 2014, org: "Musana Community Development Org", amount: 2500 },
  { id: 125, year: 2014, org: "Care and Share", amount: 2000 },
  { id: 126, year: 2014, org: "Indian River Habitat for Humanity", amount: 1500 },
  { id: 127, year: 2013, org: "Enviromental Learning Center", amount: 7000 },
  { id: 128, year: 2013, org: "The Neighborhood Academy", amount: 5000 },
  { id: 129, year: 2013, org: "Alexander Leigh Center for Autism", amount: 2500 },
  { id: 130, year: 2013, org: "MCC Foundation", amount: 1000 },
  { id: 131, year: 2013, org: "Indian River Habitat for Humanity", amount: 1000 },
  { id: 132, year: 2013, org: "Indian River Land Trust", amount: 500 },
  { id: 133, year: 2012, org: "Huron County Coalition Against Domestic Violence", amount: 6270 },
  { id: 134, year: 2012, org: "Enviromental Learning Center", amount: 3500 },
  { id: 135, year: 2012, org: "The Neighborhood Academy", amount: 1000 },
  { id: 136, year: 2011, org: "Huron County Coalition Against Domestic Violence", amount: 12000 },
  { id: 137, year: 2011, org: "Salvation Army", amount: 2158 },
  { id: 138, year: 2011, org: "Parla", amount: 1000 },
  { id: 139, year: 2011, org: "MCC Foundation", amount: 350 },
  { id: 140, year: 2010, org: "Huron County Coalition Against Domestic Violence", amount: 84403 },
  { id: 141, year: 2010, org: "The Learning Tree of Crystal Lake", amount: 150 },
  { id: 142, year: 2009, org: "Huron County Coalition Against Domestic Violence", amount: 60000 },
  { id: 143, year: 2008, org: "Huron County Coalition Against Domestic Violence", amount: 50000 },
  { id: 144, year: 2008, org: "Youth Service Bureau", amount: 250 },
  { id: 145, year: 2007, org: "Huron County Coalition Against Domestic Violence", amount: 100000 },
  { id: 146, year: 2007, org: "The Neighborhood Academy", amount: 100 },
  { id: 147, year: 2007, org: "Scheurer Hospital", amount: 100 },
  { id: 148, year: 2006, org: "Huron County Coalition Against Domestic Violence", amount: 59456 },
  { id: 149, year: 2005, org: "Huron County Coalition Against Domestic Violence", amount: 50000 },
  { id: 150, year: 2005, org: "Alzheimer's Association", amount: 200 },
  { id: 151, year: 2005, org: "Huron County Community Foundation", amount: 200 },
  { id: 152, year: 2005, org: "The Neighborhood Academy", amount: 100 },
  { id: 153, year: 2005, org: "Scheurer Hospital", amount: 100 },
  { id: 154, year: 2004, org: "Huron County Coalition Against Domestic Violence", amount: 58250 },
  { id: 155, year: 2004, org: "The Neighborhood Academy", amount: 500 },
  { id: 156, year: 2004, org: "Care and Share", amount: 200 },
  { id: 157, year: 2003, org: "Huron Community Foundation", amount: 18405 },
  { id: 158, year: 2003, org: "Huron Development Commission", amount: 1000 },
  { id: 159, year: 2003, org: "St. John's Northwestern Military Academy", amount: 500 },
  { id: 160, year: 2002, org: "Care and Share", amount: 1500 },
  { id: 161, year: 2002, org: "Huron Community Foundation", amount: 1500 },
  { id: 162, year: 2002, org: "Port Austin Good Fellows", amount: 1000 },
  { id: 163, year: 2002, org: "Jaycee's", amount: 600 },
  { id: 164, year: 2002, org: "PADS First Congregational Church / McHenry County PADS", amount: 500 },
  { id: 165, year: 2002, org: "St. John's Northwestern Military Academy", amount: 500 },
  { id: 166, year: 2002, org: "The Wellness Place", amount: 500 },
  { id: 167, year: 2002, org: "Rockford Rescue Mission", amount: 200 },
  { id: 168, year: 2002, org: "Home of the Sparrow", amount: 100 },
  { id: 169, year: 2002, org: "Alzheimer's Association", amount: 50 },
  { id: 170, year: 2002, org: "Special Olympics", amount: 50 },
  { id: 171, year: 2001, org: "American Red Cross", amount: 200 },
  { id: 172, year: 2001, org: "Juvenile Diabetes Research Foundation", amount: 50 },
  { id: 173, year: 2001, org: "PADS First Congregational Church / McHenry County PADS", amount: 50 },
  { id: 174, year: 2001, org: "Home of the Sparrow", amount: 50 },
  { id: 175, year: 2001, org: "Rockford Rescue Mission", amount: 27 },
].map(g => ({ ...g, category: ORG_CATEGORIES[g.org] || "Community & Social Services" }));

const DONATIONS_RECEIVED = [
  { id: 1, year: 2000, donor: "Chris & Dave Smith", amount: 149224 },
  { id: 2, year: 2001, donor: "Chris & Dave Smith", amount: 15966 },
  { id: 3, year: 2001, donor: "Kendra C. Smith", amount: 5000 },
  { id: 4, year: 2001, donor: "David P. Smith III", amount: 5000 },
  { id: 5, year: 2001, donor: "Carla S. Dobbeck", amount: 5000 },
  { id: 6, year: 2002, donor: "Chris & Dave Smith", amount: 1000 },
  { id: 7, year: 2004, donor: "Chris & Dave Smith", amount: 82247 },
  { id: 8, year: 2005, donor: "Chris & Dave Smith", amount: 123629 },
  { id: 9, year: 2006, donor: "Chris & Dave Smith", amount: 160411 },
  { id: 10, year: 2007, donor: "Chris & Dave Smith", amount: 50000 },
  { id: 11, year: 2008, donor: "Chris & Dave Smith", amount: 50000 },
  { id: 12, year: 2009, donor: "Chris & Dave Smith", amount: 315000 },
  { id: 13, year: 2010, donor: "Chris & Dave Smith", amount: 125000 },
  { id: 14, year: 2011, donor: "Chris & Dave Smith", amount: 50000 },
  { id: 15, year: 2012, donor: "Chris & Dave Smith", amount: 101662 },
  { id: 16, year: 2015, donor: "Chris & Dave Smith", amount: 125920 },
  { id: 17, year: 2018, donor: "Chris & Dave Smith", amount: 291776 },
  { id: 18, year: 2019, donor: "Chris & Dave Smith", amount: 393497 },
  { id: 19, year: 2021, donor: "Chris & Dave Smith", amount: 225000 },
  { id: 20, year: 2022, donor: "Chris & Dave Smith", amount: 300000 },
  { id: 21, year: 2023, donor: "Chris & Dave Smith", amount: 69804 },
  { id: 22, year: 2024, donor: "Chris & Dave Smith", amount: 400000 },
  { id: 23, year: 2025, donor: "Chris & Dave Smith", amount: 323247 },
];

// =============================================================================
//  CONSTANTS & HELPERS
// =============================================================================

const ALL_YEARS = ["All Years", ...Array.from(new Set(GRANTS.map(g => g.year))).sort((a,b) => b-a)];
const ALL_ORGS  = ["All Organizations", ...Array.from(new Set(GRANTS.map(g => g.org))).sort()];
const ALL_CATS  = ["All Categories", ...Array.from(new Set(GRANTS.map(g => g.category))).sort()];

const CAT_COLORS = {
  "Children & Youth":         "#0B6E6E",
  "Domestic Violence":        "#B5451B",
  "Food & Hunger":            "#C8A020",
  "Healthcare":               "#3A6B9C",
  "Arts & Culture":           "#7B5EA7",
  "Education":                "#2E7D5E",
  "Environment & Wildlife":   "#4A7C59",
  "Community Development":    "#6B8E9F",
  "Community & Social Services": "#8A6B4E",
  "Religious":                "#9E7B5A",
};

const fmt    = n => "$" + Number(n).toLocaleString();
const fmtK   = n => n >= 1000000 ? "$" + (n/1000000).toFixed(1) + "M" : n >= 1000 ? "$" + Math.round(n/1000) + "k" : "$" + n;

// =============================================================================
//  SUB-COMPONENTS
// =============================================================================

function StatCard({ label, value, sub, accent }) {
  return (
    <div style={{ background: "#fff", border: "1px solid #D8EEEE", borderRadius: 12, padding: "20px 24px", borderTop: "3px solid " + (accent || "#0B6E6E") }}>
      <div style={{ fontSize: 11, fontFamily: "'Cormorant Garamond', serif", letterSpacing: "0.12em", textTransform: "uppercase", color: "#5A8080", marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 28, fontWeight: 700, color: "#111D1D", fontFamily: "'Cormorant Garamond', serif", lineHeight: 1 }}>{value}</div>
      {sub && <div style={{ fontSize: 12, color: "#7A9898", marginTop: 4, fontFamily: "'DM Sans', sans-serif" }}>{sub}</div>}
    </div>
  );
}

function FilterSelect({ label, value, onChange, options }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <label style={{ fontSize: 10, fontFamily: "'Cormorant Garamond', serif", letterSpacing: "0.1em", textTransform: "uppercase", color: "#5A8080" }}>{label}</label>
      <select value={value} onChange={e => onChange(e.target.value)} style={{
        border: "1px solid #C0DEDE", borderRadius: 6, padding: "7px 28px 7px 10px", fontSize: 13,
        fontFamily: "'DM Sans', sans-serif", color: "#111D1D", background: "#F5FBFB", appearance: "none",
        backgroundImage: "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%235A8080'/%3E%3C/svg%3E\")",
        backgroundRepeat: "no-repeat", backgroundPosition: "right 10px center", cursor: "pointer", minWidth: 180,
      }}>
        {options.map(o => <option key={o} value={o}>{o}</option>)}
      </select>
    </div>
  );
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #D8EEEE", borderRadius: 8, padding: "10px 14px", fontSize: 13, fontFamily: "'DM Sans', sans-serif", boxShadow: "0 4px 12px rgba(0,0,0,0.08)" }}>
      <div style={{ fontWeight: 600, marginBottom: 4, color: "#111D1D" }}>{label}</div>
      {payload.map((p, i) => <div key={i} style={{ color: p.color || "#0B6E6E" }}>{fmt(p.value)}</div>)}
    </div>
  );
};

// =============================================================================
//  MAIN DASHBOARD
// =============================================================================

export default function KendacarDashboard() {
  const [yearFilter, setYearFilter] = useState("All Years");
  const [orgFilter,  setOrgFilter]  = useState("All Organizations");
  const [catFilter,  setCatFilter]  = useState("All Categories");
  const [tab, setTab] = useState("grants");

  const filtered = useMemo(() => GRANTS.filter(g => {
    if (yearFilter !== "All Years" && g.year !== Number(yearFilter)) return false;
    if (orgFilter  !== "All Organizations" && g.org !== orgFilter)   return false;
    if (catFilter  !== "All Categories" && g.category !== catFilter) return false;
    return true;
  }), [yearFilter, orgFilter, catFilter]);

  const totalGiven   = filtered.reduce((s, g) => s + g.amount, 0);
  const uniqueOrgs   = new Set(filtered.map(g => g.org)).size;
  const totalAllTime = GRANTS.reduce((s, g) => s + g.amount, 0);

  // YOY bar data
  const yoyData = useMemo(() => {
    const byYear = {};
    GRANTS.forEach(g => { byYear[g.year] = (byYear[g.year] || 0) + g.amount; });
    return Object.entries(byYear).sort((a,b) => a[0]-b[0]).map(([yr, amt]) => ({ year: yr, amount: amt }));
  }, []);

  // Org-specific history
  const orgHistory = useMemo(() => {
    if (orgFilter === "All Organizations") return [];
    const byYear = {};
    GRANTS.filter(g => g.org === orgFilter).forEach(g => { byYear[g.year] = (byYear[g.year] || 0) + g.amount; });
    return Object.entries(byYear).sort((a,b) => a[0]-b[0]).map(([yr, amt]) => ({ year: yr, amount: amt }));
  }, [orgFilter]);

  // Category data for filtered set
  const catData = useMemo(() => {
    const byCat = {};
    filtered.forEach(g => { byCat[g.category] = (byCat[g.category] || 0) + g.amount; });
    return Object.entries(byCat).map(([name, value]) => ({ name, value })).sort((a,b) => b.value-a.value);
  }, [filtered]);

  // Donations area chart
  const donByYear = useMemo(() => {
    const byYear = {};
    DONATIONS_RECEIVED.forEach(d => { byYear[d.year] = (byYear[d.year] || 0) + d.amount; });
    return Object.entries(byYear).sort((a,b) => a[0]-b[0]).map(([yr, amt]) => ({ year: yr, amount: amt }));
  }, []);

  const TABS = [
    { id: "grants",    label: "Grant Log" },
    { id: "yoy",       label: "Year Over Year" },
    { id: "categories",label: "By Category" },
    { id: "donations", label: "Donations In" },
  ];

  const hasFilters = yearFilter !== "All Years" || orgFilter !== "All Organizations" || catFilter !== "All Categories";

  return (
    <div style={{ minHeight: "100vh", background: "#F0F8F8", fontFamily: "'DM Sans', sans-serif", color: "#111D1D" }}>
      {/* Header */}
      <div style={{ background: "#0B6E6E", color: "#fff", padding: "32px 40px 28px", display: "flex", alignItems: "flex-end", justifyContent: "space-between", flexWrap: "wrap", gap: 20 }}>
        <div>
          <div style={{ fontSize: 11, letterSpacing: "0.18em", textTransform: "uppercase", color: "#A8D5D5", marginBottom: 6, fontFamily: "'Cormorant Garamond', serif" }}>Family Philanthropy</div>
          <h1 style={{ margin: 0, fontSize: 36, fontFamily: "'Cormorant Garamond', serif", fontWeight: 700, lineHeight: 1.1 }}>Kendacar Foundation</h1>
          <div style={{ fontSize: 13, color: "#A8D5D5", marginTop: 6 }}>Grant History & Giving Overview â 2001 to Present</div>
        </div>
        <div style={{ textAlign: "right" }}>
          <div style={{ fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", color: "#A8D5D5", marginBottom: 4, fontFamily: "'Cormorant Garamond', serif" }}>Total Giving All Time</div>
          <div style={{ fontSize: 36, fontFamily: "'Cormorant Garamond', serif", fontWeight: 700 }}>{fmt(totalAllTime)}</div>
          <div style={{ fontSize: 12, color: "#A8D5D5", marginTop: 2 }}>175 grants across 67 organizations</div>           <a href="./kendacar_scenarios.html" target="_blank" style={{             display: "inline-block", marginTop: 14, padding: "8px 18px",             background: "rgba(255,255,255,0.12)", border: "1px solid rgba(255,255,255,0.3)",             borderRadius: 6, color: "#fff", fontSize: 12, fontFamily: "'DM Sans', sans-serif",             fontWeight: 500, textDecoration: "none", letterSpacing: "0.04em"           }}>             📊 Giving Scenarios →           </a>
        </div>
      </div>

      <div style={{ padding: "28px 40px", maxWidth: 1140, margin: "0 auto" }}>
        {/* Filters */}
        <div style={{ background: "#fff", border: "1px solid #C8E8E8", borderRadius: 12, padding: "16px 20px", display: "flex", gap: 20, alignItems: "flex-end", flexWrap: "wrap", marginBottom: 24 }}>
          <div style={{ fontSize: 12, fontFamily: "'Cormorant Garamond', serif", letterSpacing: "0.1em", textTransform: "uppercase", color: "#5A8080", alignSelf: "center", paddingBottom: 2 }}>Filter</div>
          <FilterSelect label="Year" value={yearFilter} onChange={setYearFilter} options={ALL_YEARS.map(String)} />
          <FilterSelect label="Organization" value={orgFilter} onChange={setOrgFilter} options={ALL_ORGS} />
          <FilterSelect label="Category" value={catFilter} onChange={setCatFilter} options={ALL_CATS} />
          {hasFilters && (
            <button onClick={() => { setYearFilter("All Years"); setOrgFilter("All Organizations"); setCatFilter("All Categories"); }}
              style={{ background: "none", border: "1px solid #C0DEDE", borderRadius: 6, padding: "7px 14px", fontSize: 12, color: "#5A8080", cursor: "pointer", fontFamily: "'DM Sans', sans-serif" }}>
              Clear
            </button>
          )}
        </div>

        {/* Stat Cards */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 28 }}>
          <StatCard label="Grants in View" value={fmt(totalGiven)} sub={filtered.length + " grants"} accent="#0B6E6E" />
          <StatCard label="Organizations" value={uniqueOrgs} sub="unique grantees" accent="#C8A020" />
          <StatCard label="Investment Balance" value="$3.68M" sub="as of Aug 2025" accent="#3A6B9C" />
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 2, marginBottom: 20, borderBottom: "2px solid #C8E8E8" }}>
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              background: "none", border: "none", borderBottom: tab === t.id ? "2px solid #0B6E6E" : "2px solid transparent",
              marginBottom: -2, padding: "10px 18px", fontSize: 13, fontFamily: "'DM Sans', sans-serif",
              fontWeight: tab === t.id ? 600 : 400, color: tab === t.id ? "#0B6E6E" : "#5A8080", cursor: "pointer",
            }}>{t.label}</button>
          ))}
        </div>

        {/* Grant Log */}
        {tab === "grants" && (
          <div style={{ background: "#fff", border: "1px solid #C8E8E8", borderRadius: 12, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: "#F0F8F8", borderBottom: "1px solid #C8E8E8" }}>
                  {["Year", "Organization", "Category", "Amount"].map(h => (
                    <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontFamily: "'Cormorant Garamond', serif", fontWeight: 600, fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#5A8080", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr><td colSpan={4} style={{ padding: 32, textAlign: "center", color: "#5A8080" }}>No grants match your filters.</td></tr>
                )}
                {filtered.sort((a, b) => b.year - a.year || b.amount - a.amount).map((g, i) => (
                  <tr key={g.id} style={{ borderBottom: "1px solid #EAF5F5", background: i % 2 === 0 ? "#fff" : "#F8FCFC" }}>
                    <td style={{ padding: "11px 16px", color: "#5A8080", fontWeight: 500 }}>{g.year}</td>
                    <td style={{ padding: "11px 16px", fontWeight: 500 }}>{g.org}</td>
                    <td style={{ padding: "11px 16px" }}>
                      <span style={{ background: (CAT_COLORS[g.category] || "#999") + "18", color: CAT_COLORS[g.category] || "#999", borderRadius: 20, padding: "3px 10px", fontSize: 11, fontWeight: 600, whiteSpace: "nowrap" }}>{g.category}</span>
                    </td>
                    <td style={{ padding: "11px 16px", fontWeight: 700, color: "#0B6E6E", whiteSpace: "nowrap" }}>{fmt(g.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Year Over Year */}
        {tab === "yoy" && (
          <div style={{ display: "grid", gridTemplateColumns: orgFilter !== "All Organizations" ? "1fr 1fr" : "1fr", gap: 20 }}>
            <div style={{ background: "#fff", border: "1px solid #C8E8E8", borderRadius: 12, padding: 24 }}>
              <div style={{ fontFamily: "'Cormorant Garamond', serif", fontWeight: 600, fontSize: 18, marginBottom: 4 }}>Total Giving by Year</div>
              <div style={{ fontSize: 12, color: "#5A8080", marginBottom: 20 }}>2001 through 2025</div>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={yoyData} margin={{ bottom: 10 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#EAF5F5" />
                  <XAxis dataKey="year" tick={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11 }} interval={2} />
                  <YAxis tickFormatter={fmtK} tick={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Bar dataKey="amount" fill="#0B6E6E" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
            {orgFilter !== "All Organizations" && orgHistory.length > 0 && (
              <div style={{ background: "#fff", border: "1px solid #C8E8E8", borderRadius: 12, padding: 24 }}>
                <div style={{ fontFamily: "'Cormorant Garamond', serif", fontWeight: 600, fontSize: 18, marginBottom: 4 }}>{orgFilter}</div>
                <div style={{ fontSize: 12, color: "#5A8080", marginBottom: 20 }}>Giving history for this organization</div>
                <ResponsiveContainer width="100%" height={280}>
                  <LineChart data={orgHistory}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#EAF5F5" />
                    <XAxis dataKey="year" tick={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11 }} />
                    <YAxis tickFormatter={fmtK} tick={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11 }} />
                    <Tooltip content={<CustomTooltip />} />
                    <Line type="monotone" dataKey="amount" stroke="#C8A020" strokeWidth={2.5} dot={{ fill: "#C8A020", r: 5 }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </div>
        )}

        {/* By Category */}
        {tab === "categories" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <div style={{ background: "#fff", border: "1px solid #C8E8E8", borderRadius: 12, padding: 24 }}>
              <div style={{ fontFamily: "'Cormorant Garamond', serif", fontWeight: 600, fontSize: 18, marginBottom: 20 }}>Giving by Focus Area</div>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie data={catData} dataKey="value" nameKey="name" cx="50%" cy="50%" innerRadius={55} outerRadius={100} paddingAngle={2}>
                    {catData.map(entry => <Cell key={entry.name} fill={CAT_COLORS[entry.name] || "#999"} />)}
                  </Pie>
                  <Tooltip formatter={v => fmt(v)} contentStyle={{ fontFamily: "'DM Sans', sans-serif", fontSize: 13 }} />
                  <Legend wrapperStyle={{ fontFamily: "'DM Sans', sans-serif", fontSize: 12 }} />
                </PieChart>
              </ResponsiveContainer>
            </div>
            <div style={{ background: "#fff", border: "1px solid #C8E8E8", borderRadius: 12, padding: 24 }}>
              <div style={{ fontFamily: "'Cormorant Garamond', serif", fontWeight: 600, fontSize: 18, marginBottom: 20 }}>Breakdown</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 13 }}>
                {catData.map(c => {
                  const pct = totalGiven ? Math.round((c.value / totalGiven) * 100) : 0;
                  return (
                    <div key={c.name}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
                        <span style={{ fontWeight: 500 }}>{c.name}</span>
                        <span style={{ color: "#5A8080" }}>{fmt(c.value)} <span style={{ fontSize: 11 }}>({pct}%)</span></span>
                      </div>
                      <div style={{ height: 6, background: "#EAF5F5", borderRadius: 3 }}>
                        <div style={{ height: 6, width: pct + "%", background: CAT_COLORS[c.name] || "#999", borderRadius: 3 }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* Donations In */}
        {tab === "donations" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <div style={{ background: "#fff", border: "1px solid #C8E8E8", borderRadius: 12, padding: 24 }}>
              <div style={{ fontFamily: "'Cormorant Garamond', serif", fontWeight: 600, fontSize: 18, marginBottom: 4 }}>Donations to Kendacar Foundation</div>
              <div style={{ fontSize: 12, color: "#5A8080", marginBottom: 20 }}>
                Total contributed: <strong style={{ color: "#0B6E6E" }}>{fmt(DONATIONS_RECEIVED.reduce((s,d) => s+d.amount, 0))}</strong>
              </div>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={donByYear}>
                  <defs>
                    <linearGradient id="tealGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0B6E6E" stopOpacity={0.15} />
                      <stop offset="95%" stopColor="#0B6E6E" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#EAF5F5" />
                  <XAxis dataKey="year" tick={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11 }} interval={3} />
                  <YAxis tickFormatter={fmtK} tick={{ fontFamily: "'DM Sans', sans-serif", fontSize: 11 }} />
                  <Tooltip content={<CustomTooltip />} />
                  <Area type="monotone" dataKey="amount" stroke="#0B6E6E" strokeWidth={2} fill="url(#tealGrad)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div style={{ background: "#fff", border: "1px solid #C8E8E8", borderRadius: 12, overflow: "hidden" }}>
              <div style={{ padding: "16px 20px", borderBottom: "1px solid #EAF5F5" }}>
                <div style={{ fontFamily: "'Cormorant Garamond', serif", fontWeight: 600, fontSize: 18 }}>Contribution History</div>
              </div>
              <div style={{ maxHeight: 320, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: "#F0F8F8" }}>
                      {["Year", "Donor", "Amount"].map(h => (
                        <th key={h} style={{ padding: "10px 16px", textAlign: "left", fontFamily: "'Cormorant Garamond', serif", fontSize: 11, letterSpacing: "0.08em", textTransform: "uppercase", color: "#5A8080" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {DONATIONS_RECEIVED.sort((a,b) => b.year - a.year).map((d, i) => (
                      <tr key={d.id} style={{ borderBottom: "1px solid #EAF5F5", background: i % 2 === 0 ? "#fff" : "#F8FCFC" }}>
                        <td style={{ padding: "10px 16px", color: "#5A8080" }}>{d.year}</td>
                        <td style={{ padding: "10px 16px", fontWeight: 500 }}>{d.donor}</td>
                        <td style={{ padding: "10px 16px", fontWeight: 700, color: "#0B6E6E" }}>{fmt(d.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        <div style={{ marginTop: 36, textAlign: "center", fontSize: 11, color: "#7A9898", fontFamily: "'Cormorant Garamond', serif", letterSpacing: "0.08em" }}>
          KENDACAR FOUNDATION &middot; CONFIDENTIAL &middot; FOR FAMILY USE ONLY
        </div>
      </div>
    </div>
  );
}
