import { pathToFileURL } from "node:url";

import { closeDB, connectDB } from "../config/db.js";
import { ensureDatabaseCollectionsAndIndexes } from "../config/dbIndexes.js";
import {
  EQUIPMENT_CATEGORIES,
  EQUIPMENT_STATUSES,
} from "../constants/equipment.js";
import { USER_ROLES } from "../constants/roles.js";
import {
  buildEquipmentDocument,
  getEquipmentCollection,
} from "../models/equipment.model.js";
import { getUsersCollection } from "../models/user.model.js";

const IMAGE_BASE_URL = "https://b14-a-009-client.vercel.app/images/equipment";

export const DEMO_CATEGORY_ITEMS = Object.freeze([
  // Photography Equipment (adds 2 -> 3 Approved total)
  {
    name: "Bi-Color Studio LED 3-Light Softbox Kit",
    description:
      "Three 300W bi-color COB LED studio heads paired with octagonal softboxes, chrome C-stands, weighted sandbags, and a rolling padded road case for commercial film sets and portrait studios.",
    category: "Photography Equipment",
    location: "Dhanmondi, Dhaka",
    rentalPrice: 3200,
    rentalType: "Daily",
    availableQuantity: 5,
    condition: "Like New",
    brand: "LumenPro",
    model: "300X Trio Kit",
    image: `${IMAGE_BASE_URL}/studio-led-lighting-kit.jpg`,
    rentalTerms:
      "Inspect all COB LED fixtures and AC power bricks before dispatch. Allow lamp heads to cool for 10 minutes before packing into flight cases.",
  },
  {
    name: "3-Axis Motorized Cinema Gimbal Stabilizer",
    description:
      "Carbon-fiber 3-axis cinema gimbal supporting payloads up to 4.5 kg with LiDAR focus integration, briefcase handle, dual-battery grip, and weather-sealed hard transport case.",
    category: "Photography Equipment",
    location: "Gulshan, Dhaka",
    rentalPrice: 2400,
    rentalType: "Daily",
    availableQuantity: 4,
    condition: "Excellent",
    brand: "AxisMotion",
    model: "RS4 Cinema Pro",
    image: `${IMAGE_BASE_URL}/cinema-gimbal-stabilizer.jpg`,
    rentalTerms:
      "Calibrate payload balance prior to powering motors. Return balanced quick-release plate, cables, and batteries fully packed inside hard case.",
  },

  // Vehicles & Transportation (adds 2 -> 3 Approved total)
  {
    name: "High-Roof Commercial Cargo Van 14ft",
    description:
      "Extended high-roof commercial cargo van offering 14 feet of enclosed tie-down load bay, reinforced floor anchors, rear 270-degree swing doors, and backup camera for regional freight.",
    category: "Vehicles & Transportation",
    location: "Tejgaon, Dhaka",
    rentalPrice: 6800,
    rentalType: "Daily",
    availableQuantity: 3,
    condition: "Excellent",
    brand: "TransitHaul",
    model: "T-350 HR",
    image: `${IMAGE_BASE_URL}/commercial-cargo-van.jpg`,
    rentalTerms:
      "Valid commercial driving license and national ID verification required at pickup. Return with full diesel tank and clean cargo bay.",
  },
  {
    name: "16ft Insulated Box Truck with Hydraulic Liftgate",
    description:
      "Sixteen-foot enclosed box truck equipped with a 1,200 kg aluminum hydraulic tuck-away liftgate, e-track wall rails, and dock-height bumper built for event production and pallet logistics.",
    category: "Vehicles & Transportation",
    location: "Chattogram, Bangladesh",
    rentalPrice: 38500,
    rentalType: "Weekly",
    availableQuantity: 2,
    condition: "Good",
    brand: "Isuzu Fleet",
    model: "NPR-HD 16",
    image: `${IMAGE_BASE_URL}/refrigerated-box-truck.jpg`,
    rentalTerms:
      "Observe 3.4m bridge clearance markings along route. Liftgate must remain locked in stowed position before driving on public roads.",
  },

  // Agriculture Equipment (adds 2 -> 3 Approved total)
  {
    name: "Autonomous Agricultural Crop Spraying Drone 30L",
    description:
      "Heavy-lift hexacopter precision crop sprayer featuring a 30-liter tank, RTK centimeter-level path mapping, radar terrain following, and fast-charge field battery station.",
    category: "Agriculture Equipment",
    location: "Cumilla, Bangladesh",
    rentalPrice: 8200,
    rentalType: "Daily",
    availableQuantity: 2,
    condition: "Like New",
    brand: "AeroFarm",
    model: "AgraJet T30",
    image: `${IMAGE_BASE_URL}/agricultural-spray-drone.jpg`,
    rentalTerms:
      "Flush tank and boom nozzles cleanly with fresh water after each spraying block. Operate strictly in winds under 18 km/h by certified pilot.",
  },
  {
    name: "Heavy-Duty Tractor Rotary Tiller & Seed Drill",
    description:
      "Category-II 3-point hitch 6-foot rotary tiller combined with integrated precision grain seed hopper, depth gauge roller, and hardened boron steel blades for rapid soil bed preparation.",
    category: "Agriculture Equipment",
    location: "Bogura, Bangladesh",
    rentalPrice: 3500,
    rentalType: "Daily",
    availableQuantity: 3,
    condition: "Excellent",
    brand: "AgriForce",
    model: "RT-180 Drill",
    image: `${IMAGE_BASE_URL}/tractor-rotary-tiller.jpg`,
    rentalTerms:
      "Verify 540 RPM PTO slip-clutch clearance before field engagement. Remove packed mud and crop residue from rotor tines before return.",
  },

  // Electronics (adds 2 -> 3 Approved total)
  {
    name: "Pro Thermal Imaging & Circuit Diagnostic Camera",
    description:
      "High-sensitivity 320x240 infrared thermal diagnostic camera with laser distance meter, picture-in-picture overlay, electrical panel calibration certificate, and protective travel case.",
    category: "Electronics",
    location: "Banani, Dhaka",
    rentalPrice: 3900,
    rentalType: "Daily",
    availableQuantity: 4,
    condition: "Like New",
    brand: "ThermoScan",
    model: "T540 Field",
    image: `${IMAGE_BASE_URL}/thermal-diagnostic-camera.jpg`,
    rentalTerms:
      "Keep protective germanium lens cap closed between switchgear inspections. Handle display screen with provided wrist strap attached.",
  },
  {
    name: "Portable 3kWh LiFePO4 Solar Power Station",
    description:
      "3,072 Wh silent lithium-iron-phosphate power station delivering 3,000W pure-sine AC output alongside two foldable 200W monocrystalline solar panels for silent off-grid production.",
    category: "Electronics",
    location: "Mirpur, Dhaka",
    rentalPrice: 16500,
    rentalType: "Weekly",
    availableQuantity: 5,
    condition: "Excellent",
    brand: "GridSense",
    model: "VoltHub 3000",
    image: `${IMAGE_BASE_URL}/portable-solar-power-station.jpg`,
    rentalTerms:
      "Keep AC inverter vents unobstructed and elevated off damp soil. Wipe solar panel glass cleanly before folding into travel sleeve.",
  },

  // Event Equipment (adds 3 Approved total)
  {
    name: "Modular Aluminum Event Stage & Truss Canopy Kit",
    description:
      "16x12 ft slip-resistant black stage deck platform framed by anodized 290mm square aluminum box trussing and UV-resistant white canopy roof for outdoor concerts and corporate launches.",
    category: "Event Equipment",
    location: "Bashundhara, Dhaka",
    rentalPrice: 45000,
    rentalType: "Weekly",
    availableQuantity: 2,
    condition: "Excellent",
    brand: "StageLock",
    model: "TrussDeck 1612",
    image: `${IMAGE_BASE_URL}/event-stage-truss-canopy.jpg`,
    rentalTerms:
      "Requires level ground surface and ballast sandbags anchored on all four corner uprights. Truss couplers must only be assembled with steel R-clips.",
  },
  {
    name: "DMX Moving-Head LED Event Lighting Rig",
    description:
      "Set of 4 synchronized 280W beam-wash DMX moving-head fixtures complete with 512-channel lighting console, powerCON daisy cables, safety tethers, and dual-compartment road cases.",
    category: "Event Equipment",
    location: "Motijheel, Dhaka",
    rentalPrice: 6400,
    rentalType: "Daily",
    availableQuantity: 4,
    condition: "Like New",
    brand: "BeamCraft",
    model: "MH-280 Quad",
    image: `${IMAGE_BASE_URL}/moving-head-stage-lighting.jpg`,
    rentalTerms:
      "Attach secondary steel safety cables whenever rigging overhead. Unlock pan/tilt travel clamps before powering on fixtures.",
  },
  {
    name: "4K Laser Event Projector & 150-Inch Screen Kit",
    description:
      "High-brightness 7,500-lumen 4K laser conference projector packaged with heavy-duty AV stand, SDI/HDMI long-run kits, and a tensioned 150-inch fast-fold projection frame.",
    category: "Event Equipment",
    location: "Uttara, Dhaka",
    rentalPrice: 8800,
    rentalType: "Daily",
    availableQuantity: 3,
    condition: "Like New",
    brand: "OptiStage",
    model: "LaserPro 7500",
    image: `${IMAGE_BASE_URL}/laser-event-projector-screen.jpg`,
    rentalTerms:
      "Use soft shutdown sequence so cooling fans finish cycle before unplugging power. Roll screen vinyl smoothly to prevent permanent creases.",
  },
]);

export async function seedCategoryEquipment() {
  const db = await connectDB();
  await ensureDatabaseCollectionsAndIndexes(db);

  const usersCol = await getUsersCollection();
  const adminUser =
    (await usersCol.findOne({ email: "admin@gearnest.app" })) ||
    (await usersCol.findOne({ role: USER_ROLES.ADMIN }));

  if (!adminUser) {
    throw new Error("Admin user not found. Run `npm run seed:admin` first.");
  }

  const adminId = String(adminUser._id || adminUser.id);
  const equipmentCol = await getEquipmentCollection();

  let inserted = 0;
  let skipped = 0;

  for (let i = 0; i < DEMO_CATEGORY_ITEMS.length; i += 1) {
    const item = DEMO_CATEGORY_ITEMS[i];
    const existing = await equipmentCol.findOne({
      name: item.name,
      isDeleted: { $ne: true },
    });

    if (existing) {
      skipped += 1;
      continue;
    }

    const baseDoc = buildEquipmentDocument({
      ...item,
      ownerId: adminId,
    });

    const timestamp = new Date(Date.now() - (DEMO_CATEGORY_ITEMS.length - i) * 60000);
    await equipmentCol.insertOne({
      ...baseDoc,
      status: EQUIPMENT_STATUSES.APPROVED,
      reviewedBy: adminId,
      reviewedAt: timestamp,
      rejectionReason: null,
      approvalHistory: [
        {
          previousStatus: EQUIPMENT_STATUSES.PENDING,
          newStatus: EQUIPMENT_STATUSES.APPROVED,
          reviewedBy: adminId,
          reviewedAt: timestamp,
          rejectionReason: null,
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    inserted += 1;
  }

  const counts = {};
  for (const category of EQUIPMENT_CATEGORIES) {
    const approvedCount = await equipmentCol.countDocuments({
      category,
      status: EQUIPMENT_STATUSES.APPROVED,
      isDeleted: { $ne: true },
    });
    const totalCount = await equipmentCol.countDocuments({
      category,
      isDeleted: { $ne: true },
    });
    counts[category] = { approvedCount, totalCount };
  }

  return { inserted, skipped, counts };
}

async function runCli() {
  try {
    const result = await seedCategoryEquipment();
    console.log("Equipment seed result:", JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error("Failed to seed category equipment:", error);
    process.exitCode = 1;
  } finally {
    await closeDB().catch(() => null);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli();
}
