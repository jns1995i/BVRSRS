require('dotenv').config();
const { MongoClient, ObjectId } = require('mongodb');

async function run() {
  const uri = process.env.MONGO_URI;
  const client = new MongoClient(uri);

  try {
    console.log("👷 Connecting to MongoDB...");
    await client.connect();
    const db = client.db();
    const residents = db.collection('resident');
    const business = db.collection('business');
    const household = db.collection('household');
    const family = db.collection('family');

    // Check if resident already exists
    const existing = await residents.findOne({ firstName: 'Francisco', lastName: 'Velasquez' });
    if (existing) {
      console.log('❗ Resident Francisco Velasquez already exists.');
      return;
    }

    // Insert household
    const houseResult = await household.insertOne({
      archive: 0,
      houseNo: "014",
      purok: "Shortcut",
      createdAt: new Date(),
      updatedAt: new Date()
    });
    const householdId = houseResult.insertedId;
    console.log(`🏠 Household inserted (_id: ${householdId})`);

    // Insert family with householdId as string
    const familyResult = await family.insertOne({
      householdId: householdId.toString(), // 🔁 ensure string format
      familyIncome: 9000,
      poverty: "Low Income",
      archive: 0,
      createdAt: new Date(),
      updatedAt: new Date()
    });
    const familyId = familyResult.insertedId;
    console.log(`👨‍👩‍👧‍👦 Family inserted (_id: ${familyId})`);

    // Insert resident with ObjectId references
    const resResult = await residents.insertOne({
      firstName: "Francisco",
      middleName: "S",
      lastName: "Velasquez",
      extName: null,
      birthPlace: "Cabanatuan",
      bMonth: "5",
      bDay: "25",
      bYear: "1961",
      gender: "Male",
      civilStatus: "Married",
      pregnant: null,
      precinct: "Registered Vote",
      phone: "09296199578",
      email: "",
      soloParent: null,
      pwd: null,
      pwdType: null,
      employmentStatus: "Employed",
      work: "Punong Barangay",
      monthlyIncome: 10000,
      position: "Punong Barangay",
      archive: 0,
      reset: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      successAt: null,
      username: "Admin",
      password: "all456",
      role: "Head",
      familyId: familyId,                  // ObjectId
      householdId: householdId,            // ObjectId
      access: 1,
      rel: "Father"
    });

    console.log(`✅ Resident inserted (_id: ${resResult.insertedId})`);

    // Insert business
    const bizResult = await business.insertOne({
      archive: 0,
      businessName: "Leah Sari Sari Store",
      createdAt: new Date(),
      updatedAt: new Date()
    });
    console.log(`🏪 Business inserted (_id: ${bizResult.insertedId})`);

  } catch (err) {
    console.error('❌ Error:', err);
  } finally {
    await client.close();
    console.log("🔌 Disconnected from MongoDB");
  }
}

run();
