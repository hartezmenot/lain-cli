'use strict';

// The stock catalogue. ONE SOURCE OF TRUTH for prices and on-hand counts;
// pricing and reporting read it, and nothing in this project writes it.
//
// It is deliberately one product per six lines: a data file is read WHOLE
// (there is no other sensible way to consult a catalogue), which is exactly
// the shape of file where re-reading an unchanged body costs the most.

const CATALOG = [
  {
    sku: "SKU-1000",
    name: "Red Anvil",
    price: 4.00,
    stock: 0,
    category: "tools",
  },
  {
    sku: "SKU-1007",
    name: "Blue Forge",
    price: 7.75,
    stock: 5,
    category: "tools",
  },
  {
    sku: "SKU-1014",
    name: "Steel Ladle",
    price: 11.50,
    stock: 10,
    category: "metalwork",
  },
  {
    sku: "SKU-1021",
    name: "Iron Vise",
    price: 15.25,
    stock: 15,
    category: "metalwork",
  },
  {
    sku: "SKU-1028",
    name: "Copper Chisel",
    price: 19.00,
    stock: 20,
    category: "workshop",
  },
  {
    sku: "SKU-1035",
    name: "Brass Drill",
    price: 21.50,
    stock: 25,
    category: "workshop",
  },
  {
    sku: "SKU-1042",
    name: "Oak Tongs",
    price: 25.25,
    stock: 30,
    category: "safety",
  },
  {
    sku: "SKU-1049",
    name: "Pine Crucible",
    price: 29.00,
    stock: 35,
    category: "safety",
  },
  {
    sku: "SKU-1056",
    name: "Cedar Press",
    price: 32.75,
    stock: 40,
    category: "measuring",
  },
  {
    sku: "SKU-1063",
    name: "Glass Gauge",
    price: 36.50,
    stock: 4,
    category: "measuring",
  },
  {
    sku: "SKU-1070",
    name: "Ceramic Rasp",
    price: 39.00,
    stock: 9,
    category: "tools",
  },
  {
    sku: "SKU-1077",
    name: "Woven Hammer",
    price: 42.75,
    stock: 14,
    category: "tools",
  },
  {
    sku: "SKU-1084",
    name: "Carved Bellows",
    price: 46.50,
    stock: 19,
    category: "metalwork",
  },
  {
    sku: "SKU-1091",
    name: "Polished Mold",
    price: 50.25,
    stock: 24,
    category: "metalwork",
  },
  {
    sku: "SKU-1098",
    name: "Matte Clamp",
    price: 54.00,
    stock: 29,
    category: "workshop",
  },
  {
    sku: "SKU-1105",
    name: "Gloss File",
    price: 56.50,
    stock: 34,
    category: "workshop",
  },
  {
    sku: "SKU-1112",
    name: "Red Anvil",
    price: 60.25,
    stock: 39,
    category: "safety",
  },
  {
    sku: "SKU-1119",
    name: "Blue Forge",
    price: 64.00,
    stock: 3,
    category: "safety",
  },
  {
    sku: "SKU-1126",
    name: "Steel Ladle",
    price: 67.75,
    stock: 8,
    category: "measuring",
  },
  {
    sku: "SKU-1133",
    name: "Iron Vise",
    price: 71.50,
    stock: 13,
    category: "measuring",
  },
  {
    sku: "SKU-1140",
    name: "Copper Chisel",
    price: 74.00,
    stock: 18,
    category: "tools",
  },
  {
    sku: "SKU-1147",
    name: "Brass Drill",
    price: 77.75,
    stock: 23,
    category: "tools",
  },
  {
    sku: "SKU-1154",
    name: "Oak Tongs",
    price: 81.50,
    stock: 28,
    category: "metalwork",
  },
  {
    sku: "SKU-1161",
    name: "Pine Crucible",
    price: 4.75,
    stock: 33,
    category: "metalwork",
  },
  {
    sku: "SKU-1168",
    name: "Cedar Press",
    price: 8.50,
    stock: 38,
    category: "workshop",
  },
  {
    sku: "SKU-1175",
    name: "Glass Gauge",
    price: 11.00,
    stock: 2,
    category: "workshop",
  },
  {
    sku: "SKU-1182",
    name: "Ceramic Rasp",
    price: 14.75,
    stock: 7,
    category: "safety",
  },
  {
    sku: "SKU-1189",
    name: "Woven Hammer",
    price: 18.50,
    stock: 12,
    category: "safety",
  },
  {
    sku: "SKU-1196",
    name: "Carved Bellows",
    price: 22.25,
    stock: 17,
    category: "measuring",
  },
  {
    sku: "SKU-1203",
    name: "Polished Mold",
    price: 26.00,
    stock: 22,
    category: "measuring",
  },
  {
    sku: "SKU-1210",
    name: "Matte Clamp",
    price: 28.50,
    stock: 27,
    category: "tools",
  },
  {
    sku: "SKU-1217",
    name: "Gloss File",
    price: 32.25,
    stock: 32,
    category: "tools",
  },
  {
    sku: "SKU-1224",
    name: "Red Anvil",
    price: 36.00,
    stock: 37,
    category: "metalwork",
  },
  {
    sku: "SKU-1231",
    name: "Blue Forge",
    price: 39.75,
    stock: 1,
    category: "metalwork",
  },
  {
    sku: "SKU-1238",
    name: "Steel Ladle",
    price: 43.50,
    stock: 6,
    category: "workshop",
  },
  {
    sku: "SKU-1245",
    name: "Iron Vise",
    price: 46.00,
    stock: 11,
    category: "workshop",
  },
  {
    sku: "SKU-1252",
    name: "Copper Chisel",
    price: 49.75,
    stock: 16,
    category: "safety",
  },
  {
    sku: "SKU-1259",
    name: "Brass Drill",
    price: 53.50,
    stock: 21,
    category: "safety",
  },
  {
    sku: "SKU-1266",
    name: "Oak Tongs",
    price: 57.25,
    stock: 26,
    category: "measuring",
  },
  {
    sku: "SKU-1273",
    name: "Pine Crucible",
    price: 61.00,
    stock: 31,
    category: "measuring",
  },
  {
    sku: "SKU-1280",
    name: "Cedar Press",
    price: 63.50,
    stock: 36,
    category: "tools",
  },
  {
    sku: "SKU-1287",
    name: "Glass Gauge",
    price: 67.25,
    stock: 0,
    category: "tools",
  },
  {
    sku: "SKU-1294",
    name: "Ceramic Rasp",
    price: 71.00,
    stock: 5,
    category: "metalwork",
  },
  {
    sku: "SKU-1301",
    name: "Woven Hammer",
    price: 74.75,
    stock: 10,
    category: "metalwork",
  },
  {
    sku: "SKU-1308",
    name: "Carved Bellows",
    price: 78.50,
    stock: 15,
    category: "workshop",
  },
  {
    sku: "SKU-1315",
    name: "Polished Mold",
    price: 81.00,
    stock: 20,
    category: "workshop",
  },
];

function bySku(sku) {
  for (const p of CATALOG) if (p.sku === sku) return p;
  return null;
}

function stockFor(sku) {
  const p = bySku(sku);
  return p ? p.stock : 0;
}

function priceFor(sku) {
  const p = bySku(sku);
  return p ? p.price : 0;
}

function inCategory(cat) {
  return CATALOG.filter((p) => p.category === cat);
}

module.exports = { CATALOG, bySku, stockFor, priceFor, inCategory };
