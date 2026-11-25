export const INITIAL_STATE = {
  money: 1500,
  carId: 'sedan_old',
  ownedParts: [],
  equippedParts: { engine: null, tires: null, body: null }
};

export const CARS = {
  sedan_old: {
    id: 'sedan_old',
    name: '1978 Városi Szedán',
    modelUrl: '/models/car_sedan.glb',
    baseStats: { accel: 24, topSpeed: 42, grip: 8, armor: 1.0 }
  }
};

export const PARTS = [
  { id: 'eng_1', slot: 'engine', name: 'Dupla Karburátor', desc: '+6 gyorsulás, +18 km/h', price: 450, bonus: { accel: 6, topSpeed: 5 } },
  { id: 'eng_2', slot: 'engine', name: 'V8 Kompresszor', desc: '+14 gyorsulás, +43 km/h', price: 1200, bonus: { accel: 14, topSpeed: 12 } },
  { id: 'tir_1', slot: 'tires', name: 'Utcai Sportgumi', desc: '+3 kanyartapadás', price: 350, bonus: { grip: 3 } },
  { id: 'bod_1', slot: 'body', name: 'Megerősített Lökhárító', desc: '+40% ütközésállóság', price: 400, bonus: { armor: 0.4 } }
];

export const TRACKS = {
  downtown: [
    [0, 0], [110, -10], [200, 45], [220, 140], [160, 215],
    [65, 225], [-10, 180], [-60, 105], [-45, 30]
  ],
  hairpin: [
    [0, 0], [130, 0], [220, 20], [250, 95], [180, 140],
    [95, 120], [50, 175], [90, 250], [190, 285], [130, 345],
    [15, 310], [-55, 210], [-50, 95]
  ]
};

export const OPPONENTS = [
  {
    id: 'opp_taxi',
    name: 'Taxis Béla',
    car: 'Sárga Taxi',
    modelUrl: '/models/car_taxi.glb',
    mode: 'drag',
    distance: 400,
    bet: 300,
    aiAccel: 22,
    aiTopSpeed: 40
  },
  {
    id: 'opp_granny',
    name: 'Margit néni',
    car: 'Turbó Kombi',
    modelUrl: '/models/car_taxi.glb',
    mode: 'circuit',
    track: 'downtown',
    laps: 1,
    distance: 850,
    bet: 600,
    aiAccel: 25,
    aiTopSpeed: 41,
    aiSkill: 0.82
  },
  {
    id: 'opp_suit',
    name: 'Öltönyös Főnök',
    car: 'Fekete Limuzin',
    modelUrl: '/models/car_taxi.glb',
    mode: 'circuit',
    track: 'hairpin',
    laps: 1,
    distance: 1100,
    bet: 1000,
    aiAccel: 30,
    aiTopSpeed: 47,
    aiSkill: 0.92
  }
];