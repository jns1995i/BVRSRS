require("dotenv").config();
const express = require("express");
const { MongoClient, ObjectId } = require("mongodb");
const bodyParser = require("body-parser");
const session = require("express-session");
const MongoDBStore = require("connect-mongodb-session")(session); // Fix: Pass the session object
const engine = require("ejs-mate");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const axios = require("axios");
const ExcelJS = require("exceljs");
const PDFDocument = require("pdfkit");
const nodemailer = require('nodemailer');

const SECRET_KEY = "6LflzO4qAAAAAF4n0ABQ2YyHGPSA3RDjvtvFt1AQ";

const fs = require('fs');
const uploadDir = 'public/uploads';

if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Use the file upload middleware


const app = express();
const PORT = process.env.PORT || 3030;

app.engine("ejs", engine);
app.set("view engine", "ejs");
app.use(express.json());

app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(express.static("public"));
app.use('/uploads', express.static('public/uploads'));


// New: Configure MongoDB session store
const store = new MongoDBStore({
    uri: process.env.MONGO_URI,
    collection: "sessions"
});

// New: Catch session store errors
store.on("error", function(error) {
    console.error("Session Store Error:", error);
});

app.use(session({
    secret: process.env.SESSION_SECRET || "your_secret_key",
    resave: false,
    saveUninitialized: false,
    store: store, // New: Use the MongoDB store
    cookie: {
        secure: process.env.NODE_ENV === "production",
        httpOnly: true
    }
}));

const client = new MongoClient(process.env.MONGO_URI);
let db;

client.connect()
    .then(() => {
        db = client.db();
        console.log("✅ Connected to MongoDB");
    })
    .catch(err => console.error("❌ MongoDB Connection Error:", err));

const requireAuth = (req, res, next) => {
    if (!req.session.userId) {
        return res.redirect("/");
    }
    next();
};

const isLogin = async (req, res, next) => {
    try {
        // ✅ 1. Check session
        if (!req.session.userId) {
            console.log("No session userId found");
            return res.redirect("/");
        }

        // ✅ 2. Convert userId to ObjectId safely
        let userId = req.session.userId;
        if (typeof userId === "string" && ObjectId.isValid(userId)) {
            userId = new ObjectId(userId);
        }

        // ✅ 3. Fetch user from DB
        const user = await db.collection("resident").findOne({ _id: userId });
        if (!user) {
            console.log("User not found for ID:", userId);
            return res.redirect("/");
        }

        // ✅ 4. Block archived/suspended users
        if (user.archive == 1 || user.suspend == 1) { // == handles both string/number
            console.log("Blocked user tried to access:", user.username);
            req.session.destroy(() => {
                return res.render("index", { error: "Your account is suspended!" });
            });
            return;
        }

        // ✅ 5. Optional household
        let household = null;
        if (user.householdId && ObjectId.isValid(user.householdId)) {
            household = await db.collection("household").findOne({ _id: new ObjectId(user.householdId) });
        }

        // ✅ 6. Optional family
        let family = null;
        if (user.familyId && ObjectId.isValid(user.familyId)) {
            family = await db.collection("family").findOne({ _id: new ObjectId(user.familyId) });
        }

        // ✅ 7. Optional cases (can be empty)
        const cases = await db.collection("cases").find({
            $or: [
                { respondents: user._id },
                { complainants: user._id }
            ],
            archive: { $in: [0, "0"] },
            suspend: { $in: [0, "0"] }
        }).toArray();

        // ✅ 8. Fetch all residents involved in cases
        let persons = [];
        if (cases.length > 0) {
            const allPersonIds = [
                ...new Set(cases.flatMap(c => [...c.respondents, ...c.complainants]))
            ];
            persons = await db.collection("resident").find({
                _id: { $in: allPersonIds.map(id => new ObjectId(id)) }
            }).toArray();

            cases.forEach(c => {
                c.respondents = c.respondents.map(rid =>
                    persons.find(p => p._id.equals(rid)) || rid
                );
                c.complainants = c.complainants.map(rid =>
                    persons.find(p => p._id.equals(rid)) || rid
                );
            });
        }

        // ✅ 9. Attach to req and res.locals
        req.user = user;
        req.household = household;
        req.family = family;
        req.cases = cases;
        res.locals.user = user;
        res.locals.household = household;
        res.locals.family = family;
        res.locals.cases = cases;

        next(); // everything is fine, continue

    } catch (err) {
        console.error("Error in isLogin middleware:", err);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
};

const sumDoc = async (req, res, next) => {
    try {
        if (!db) {
            console.error("❌ Database connection is not established yet.");
            return next(); // Prevent crashing, continue with the next middleware
        }

        const validStatuses = ["Processed", "Approved", "Success", "Processing"];

        // Fetch documents with valid statuses
        const documents = await db.collection("document").find({ status: { $in: validStatuses } }).toArray();

        if (!documents.length) {
            console.warn("⚠️ No valid documents found.");
        }

        // Count total valid documents
        const totalDocuments = documents.length;

        // Count occurrences per document type
        const documentTypeCounts = documents.reduce((acc, doc) => {
            if (doc.type) {
                acc[doc.type] = (acc[doc.type] || 0) + 1;
            }
            return acc;
        }, {});

        // Convert object to array and compute percentages
        const documentTypeStats = Object.entries(documentTypeCounts).map(([type, count]) => ({
            type,
            count,
            percentage: totalDocuments ? ((count / totalDocuments) * 100).toFixed(2) : "0"
        }));

        console.log("✅ sumDoc Results:", { totalDocuments, documentTypeStats });

        req.sumDoc = { documentTypeCounts: documentTypeStats, totalDocuments };
        res.locals.sumDoc = req.sumDoc;

    } catch (err) {
        console.error("❌ Error in sumDoc middleware:", err.message);
        req.sumDoc = { documentTypeCounts: [], totalDocuments: 0 };
        res.locals.sumDoc = req.sumDoc;
    }

    next();
};

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: 'johnniebre1995@gmail.com',
        pass: 'gswplydselmqjysq',
    },
    tls: {
      rejectUnauthorized: false, // 👈 this line tells Node.js to ignore self-signed cert errors
    },
  });
  

const sumReq = async (req, res, next) => {
    try {
        if (!db) {
            console.error("❌ Database connection is not established yet.");
            return next();
        }

        const validStatuses = ["Processed", "Approved", "Success", "Processing", "For Pickup", "Claimed"];

        // Count total requests directly from MongoDB
        const totalRequests = await db.collection("request").countDocuments({
            archive: { $in: [0, "0"] },
            status: { $in: validStatuses }
        });

        console.log("✅ sumReq Results:", { totalRequests });

        req.sumReq = { totalRequests }; // Attach to request
        res.locals.sumReq = req.sumReq; // Attach to locals (optional)

    } catch (err) {
        console.error("❌ Error in sumReq middleware:", err.message);
        req.sumReq = { totalRequests: 0 };
        res.locals.sumReq = req.sumReq;
    }

    next();
};

const isAnn = async (req, res, next) => {
    try {
        const oneMonthAgo = new Date();
        oneMonthAgo.setMonth(oneMonthAgo.getMonth() - 3); // Get date 1 month ago

        // Fetch announcements created within the last month
        const announcements = await db.collection("announcements")
            .find({ createdAt: { $gte: oneMonthAgo } }) // Filter by createdAt
            .sort({ createdAt: -1 }) // Sort by updatedAt in descending order
            .toArray();

        // Attach announcements data to the request object
        req.announcements = announcements;

        // Set announcements as a global variable for all views (accessible via res.locals.announcements)
        res.locals.announcements = announcements;

        // Proceed to the next middleware or route handler
        next();
    } catch (err) {
        console.error("Error in isAnn middleware:", err.message);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
};

const myReq = async (req, res, next) => {
    try {
        if (!req.user) {
            console.log("User is not logged in.");
            return res.redirect("/");
        }

        let sessionUserId = req.user._id;
        console.log("🔎 Raw sessionUserId:", sessionUserId);

        // Convert sessionUserId to ObjectId if needed
        let objectIdUserId;
        if (typeof sessionUserId === "string" && ObjectId.isValid(sessionUserId)) {
            objectIdUserId = new ObjectId(sessionUserId);
        } else {
            objectIdUserId = sessionUserId; // Assume it's already an ObjectId
        }

        console.log("✅ Converted ObjectId:", objectIdUserId);

        // Query properly using ObjectId
        const query = { 
            requestBy: objectIdUserId, // Ensure we're using an ObjectId
            archive: { $in: [0, "0"] }
        };

        console.log("🔍 Running query:", JSON.stringify(query, null, 2));

        const requests = await db.collection("request")
            .find(query)
            .sort({ updatedAt: -1 })
            .toArray();

        console.log(`📌 Requests Found: ${requests.length}`);

        if (requests.length > 0) {
            const requestIds = requests.map(req => req._id);

            const documents = await db.collection("document")
                .find({ reqId: { $in: requestIds } })
                .toArray();

            requests.forEach(request => {
                request.documents = documents.filter(doc => 
                    doc.reqId.equals(request._id)
                );
            });
        }

        req.requests = requests;
        res.locals.requests = requests;

        next();
    } catch (err) {
        console.error("⚠️ Error in myReq middleware:", err);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
};

const isReq = async (req, res, next) => {
    try {
        // Ensure the user is logged in by checking session
        if (!req.session.userId) {
            return res.redirect("/"); // Redirect if not logged in
        }

        // Fetch requests from the 'request' collection where archive is 0
        const requests = await db.collection("request")
            .find({ archive: { $in: [0, "0"] } })
            .sort({ updatedAt: -1 }) // Sort by updatedAt in descending order
            .toArray();

        // Fetch the corresponding resident data for each request
        for (let request of requests) {
            const resident = await db.collection("resident")
                .findOne({ _id: new ObjectId(request.requestBy) }); // Fetch resident data by matching requestBy with resident ID
            request.resident = resident; // Attach the resident data to the request object

            if (resident) {
                // Fetch household data using resident.householdId
                const household = await db.collection("household")
                    .findOne({ _id: new ObjectId(resident.householdId) });
                request.household = household; // Attach the household data to the request object
            }
        }

        // Fetch corresponding documents for each request
        for (let request of requests) {
            const documents = await db.collection("document")
                .find({ reqId: request._id }) // Fetch documents where reqId matches request._id
                .toArray();
            request.documents = documents; // Attach the document data to the request object
        }

        // Attach the combined data to the request object
        req.requests = requests;

        // Set request as a global variable for all views (accessible via res.locals.requests)
        res.locals.requests = requests;

        // Proceed to the next middleware or route handler
        next();
    } catch (err) {
        console.error("Error in myReq middleware:", err.message);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
};

const isRsd = async (req, res, next) => {
    try {
        const residents = await db.collection("resident")
            .find({ archive: { $in: [0, "0"] } })
            .sort({ firstName: 1 }) // Sort by firstName in ascending order
            .toArray();

        // Fetch additional household and family data
        const familyIds = residents.map(r => r.familyId).filter(id => id); // Collect valid familyIds
        const householdIds = residents.map(r => r.householdId).filter(id => id); // Collect valid householdIds

        let families = [];
        let households = [];

        if (familyIds.length) {
            families = await db.collection("family")
                .find({ _id: { $in: familyIds.map(id => new ObjectId(id)) } })
                .toArray();
        }

        if (householdIds.length) {
            households = await db.collection("household")
                .find({ _id: { $in: householdIds.map(id => new ObjectId(id)) } })
                .toArray();
        }

        // Map families and households to their respective IDs
        const familyMap = families.reduce((acc, family) => {
            acc[family._id.toString()] = family.poverty || "N/A";
            return acc;
        }, {});

        const householdMap = households.reduce((acc, house) => {
            acc[house._id.toString()] = {
                houseNo: house.houseNo || "N/A",
                purok: house.purok || "N/A"
            };
            return acc;
        }, {});

        // Attach household & family info to each resident
        const residentsWithDetails = residents.map(resident => ({
            ...resident,
            familyPoverty: familyMap[resident.familyId?.toString()] || "N/A",
            houseNo: householdMap[resident.householdId?.toString()]?.houseNo || "N/A",
            purok: householdMap[resident.householdId?.toString()]?.purok || "N/A"
        }));

        // Attach data to request and views
        req.residents = residentsWithDetails;
        res.locals.residents = residentsWithDetails;

        next();
    } catch (err) {
        console.error("Error in isRsd middleware:", err.message);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
};


const isHr = async (req, res, next) => {
    try {
        // Fetch all hearings where archive is 0 or "0", ordered by createdAt
        const hearings = await db.collection("hearing")
            .find({ archive: { $in: [0, "0"] } }) // Filter: Only where archive is 0 or "0"
            .sort({ createdAt: -1 }) // Sort by createdAt in descending order (latest first)
            .toArray();

        // Attach hearings data to the request object
        req.hearings = hearings;

        // Set hearings as a global variable for all views (accessible via res.locals.hearings)
        res.locals.hearings = hearings;

        // Proceed to the next middleware or route handler
        next();
    } catch (err) {
        console.error("Error in isHearing middleware:", err.message);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
};

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, "public/uploads/");
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname)); // Rename file with timestamp
    }
});

const upload = multer({ storage: storage });

// Routes
app.get("/", (req, res) => res.render("index", { error: "", layout: "layout", title: "Home", activePage: "home" }));
app.get("/passSuccess", (req, res) => res.render("passSuccess", { error: "", layout: "layout", title: "Home", activePage: "home" }));
app.get("/forgot", (req, res) => {
    const error = req.query.error || ""; // Get error or set default empty string
    res.render("forgot", { layout: "forgot", title: "Forgot", activePage: "forgot", error });
});

app.get("/vvp", isRsd, (req, res) => res.render("vvp", { layout: "layout", title: "Home", activePage: "home" }));
app.get("/abt", isLogin, (req, res) => res.render("abt", { layout: "layout", title: "About Us", activePage: "abt" }));
app.get("/user", isLogin, (req, res) => res.render("user", { layout: "layout", title: "Profile", activePage: "user" }));
app.get("/prf", isLogin, (req, res) => res.render("prf", { layout: "design", title: "Profile", activePage: "prf" }));
app.get("/arc", isLogin, (req, res) => res.render("arc", { layout: "layout", title: "Archive", activePage: "dsb" }));
app.get("/his", isLogin, (req, res) => res.render("his", { layout: "design", title: "About Us", activePage: "his" }));
app.get("/1", isLogin, (req, res) => res.render("1", { layout: "design", title: "Test", activePage: "1" }));

app.get("/complaintChart", isLogin, (req, res) => res.render("complaintChart", { layout: "layout", title: "Dashboard", activePage: "dsb" }));

app.get("/design", isLogin, myReq, isAnn, (req, res) => res.render("design", { layout: "design", title: "Design", activePage: "design" }));
const RECAPTCHA_SECRET_KEY = "6Ldhle8qAAAAADd8a18EwvfWZND4zhRH-ytfFMRN"; // Replace with your actual reCAPTCHA Secret Key

app.post("/login", async (req, res) => {
    try {
        const { username, password, "g-recaptcha-response": recaptchaToken } = req.body;

        // 🔹 Ensure reCAPTCHA token exists
        if (!recaptchaToken) {
            console.log("No reCAPTCHA token received");
            return res.render("index", { error: "Please complete the reCAPTCHA." });
        }

        // 🔹 Verify reCAPTCHA with Google
        const verifyUrl = "https://www.google.com/recaptcha/api/siteverify";
        const recaptchaResponse = await axios.post(verifyUrl, null, {
            params: { secret: RECAPTCHA_SECRET_KEY, response: recaptchaToken },
        });

        console.log("reCAPTCHA Response:", recaptchaResponse.data);

        if (!recaptchaResponse.data.success) {
            return res.render("index", { error: "reCAPTCHA verification failed. Please try again." });
        }

        // 🔹 Fetch user from the database
        const user = await db.collection("resident").findOne({ username: { $regex: new RegExp(`^${username}$`, "i") } });

        if (!user) {
            console.log("User not found:", username);
            return res.render("index", { error: "Invalid username or password." });
        }

        console.log("User found:", user);

        // 🔹 Check password (direct comparison)
        if (user.password !== password) {
            console.log("Password mismatch for user:", username);
            return res.render("index", { error: "Invalid username or password." });
        }

        // 🔹 Check if suspended
        if (user.suspend === 1 || user.suspend === "1") {
            console.log("Suspended account attempted login:", username);
            return res.render("index", { error: "Account Suspended!" });
        }

        // 🔹 Set session data if login is successful
        req.session.userId = user._id.toString(); // store as string
        req.session.access = user.access; // optional

        console.log("Session set:", req.session);

        // 🔹 Redirect based on user access
        const redirectPath = user.access === 1 ? "/dsb" : user.access === 0 ? "/hom" : "/";
        return res.redirect(redirectPath);

    } catch (err) {
        console.error("Login Error:", err.message);
        return res.render("index", { error: "An error occurred. Please try again later."});
    }
});

app.post("/login2", async (req, res) => { 
    try {
        const { username, password, autoLogin } = req.body;

        // 🔹 Fetch user
        const user = await db.collection("resident").findOne({ 
            username: { $regex: new RegExp(`^${username}$`, "i") } 
        });

        if (!user) {
            console.log("User not found:", username);
            return res.send('<script>alert("Invalid username."); window.location="/index2";</script>');
        }

        console.log("User found:", user);

        // 🔹 Skip password check if autoLogin is true
        if (!autoLogin) {
            if (user.password !== password) {
                console.log("Password mismatch for user:", username);
                return res.send('<script>alert("Invalid username or password."); window.location="/index2";</script>');
            }
        }

        // 🔹 Set session
        req.session.userId = user._id;
        req.session.access = user.access;

        console.log("Session set:", req.session);

        // 🔹 Redirect based on access
        const redirectPath = user.access === 1 ? "/dsb" : user.access === 0 ? "/hom" : "/index2";
        return res.redirect(redirectPath);

    } catch (err) {
        console.error("Login Error:", err.message);
        return res.send('<script>alert("An error occurred. Please try again later."); window.location="/";</script>');
    }
});

app.post("/login20", async (req, res) => {
    try {
        const { username, password } = req.body;

        // 🔹 Fetch user from the database
        const user = await db.collection("resident").findOne({ username: { $regex: new RegExp(`^${username}$`, "i") } });

        if (!user) {
            console.log("User not found:", username);
            return res.send('<script>alert("Invalid username or password."); window.location="/index2";</script>');
        }

        console.log("User found:", user);

        // 🔹 Check password (direct comparison)
        if (user.password !== password) {
            console.log("Password mismatch for user:", username);
            return res.send('<script>alert("Invalid username or password."); window.location="/index2";</script>');
        }

        // 🔹 Set session data if login is successful
        req.session.userId = user._id;
        req.session.access = user.access;

        console.log("Session set:", req.session);

        // 🔹 Redirect based on user access
        const redirectPath = user.access === 1 ? "/dsb" : user.access === 0 ? "/hom" : "/index2";
        return res.redirect(redirectPath);

    } catch (err) {
        console.error("Login Error:", err.message);
        return res.send('<script>alert("An error occurred. Please try again later."); window.location="/";</script>');
    }
});

app.get("/rst/:id", async (req, res) => {
    try {
        const userId = req.params.id;

        // Find the user by ID
        const user = await db.collection("resident").findOne({ _id: new ObjectId(userId) });

        if (!user) {
            return res.send('<script>alert("User not found."); window.location="/";</script>');
        }

        // Render the password reset page with current password + id
        res.render("rst", { 
            userId: userId,
            currentPassword: user.password
        });

    } catch (error) {
        console.error("Error loading reset page:", error);
        res.send('<script>alert("An error occurred. Please try again later."); window.location="/";</script>');
    }
});


// Logout Route
app.get("/logout", (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error("Logout Error:", err.message);
            return res.status(500).json({ error: "Logout failed" });
        }
        res.redirect("/");
    });
});

// app.js (routes)
app.get("/ann", isLogin, async (req, res) => {
    try {
        // Fetch all announcements sorted by createdAt
        const announcements = await db.collection("announcements").find().sort({ createdAt: -1 }).toArray();
        
  const lat = 15.4869;   // Cabanatuan latitude
  const lon = 120.9730;  // Cabanatuan longitude
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;

  const response = await fetch(url);
  const weather = await response.json();

        res.render("ann", { 
            layout: "layout", 
            title: "Announcements", 
            activePage: "ann", 
                weatherCode: weather.current_weather.weathercode,
            announcements: announcements // Pass the announcements to the EJS template
        });
    } catch (err) {
        console.error("❌ Error fetching announcements:", err.message);
        res.status(500).send("Internal Server Error");
    }
});

app.post("/newAnn", upload.single("image"), async (req, res) => {
    try {
        const { title, description } = req.body;
        const imagePath = req.file ? path.join("/uploads", req.file.filename) : null;

        if (!title || !description) {
            return res.send('<script>alert("Title and Description are required!"); window.location="/ann";</script>');
        }

        const newAnnouncement = {
            title,
            description,
            image: imagePath,
            createdAt: new Date(),
        };

        await db.collection("announcements").insertOne(newAnnouncement);

        // Fetch all resident emails
        const residents = await db.collection("resident").find({ email: { $exists: true, $ne: null } }).toArray();

        // Send emails using Nodemailer
        const emailPromises = residents.map(resident => {
            const mailOptions = {
                from: 'johnniebre1995@gmail.com',
                to: resident.email,
                subject: `New Announcement: ${title}`,
                text: `Dear Resident,\n\nWe have a new announcement:\n\nTitle: ${title}\nDescription: ${description}\n\nThank you.`,
                html: `
                    <p>Dear Resident,</p>
                    <p>We have a new announcement:</p>
                    <p><strong>Title:</strong> ${title}</p>
                    <p><strong>Description:</strong> ${description}</p>
                    <p>Thank you.</p>
                `
            };

            return transporter.sendMail(mailOptions)
                .then(() => {
                    console.log(`Email successfully sent to ${resident.email}`);
                })
                .catch((error) => {
                    console.error(`Failed to send email to ${resident.email}:`, error.message);
                });
        });

        await Promise.all(emailPromises);

        res.send('<script>alert("Announcement added successfully and sent to all residents!"); window.location="/ann";</script>');

    } catch (err) {
        console.error("Error adding announcement:", err.stack);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/ann";</script>');
    }
});

app.post("/editAnn/:id", isLogin, upload.single("image"), async (req, res) => {
    try {
        const { id } = req.params; // Get the ID from the URL parameter
        const { title, description } = req.body; // Get the form fields (title and description)
        const image = req.file; // Get the uploaded image file (if any)

        // Validate the ID
        if (!ObjectId.isValid(id)) {
            return res.status(400).send('<script>alert("Invalid announcement ID!"); window.location="/ann";</script>');
        }

        const objectId = new ObjectId(id); // Convert the ID to an ObjectId

        // Fetch the existing announcement from the database
        const existingAnnouncement = await db.collection("announcements").findOne({ _id: objectId });

        if (!existingAnnouncement) {
            return res.status(404).send('<script>alert("Announcement not found!"); window.location="/ann";</script>');
        }

        // Prepare the update data object
        const updateData = {
            title: title || existingAnnouncement.title, // Use existing title if new title is not provided
            description: description || existingAnnouncement.description, // Use existing description if new description is not provided
            updatedAt: new Date() // Always update the timestamp
        };

        // If there's an image, handle it
        if (image) {
            const imagePath = '/uploads/' + image.filename; // Define the path where the image will be saved
            updateData.image = imagePath; // Save the image path to the database

            // If there was an old image, delete it from the server
            if (existingAnnouncement.image) {
                const oldImagePath = path.join(__dirname, 'public', existingAnnouncement.image);
                fs.unlink(oldImagePath, (err) => {
                    if (err) console.error("Error deleting old image:", err);
                });
            }
        } else {
            // If no new image is provided, keep the existing image
            updateData.image = existingAnnouncement.image;
        }

        // Update the announcement in the database
        const result = await db.collection("announcements").updateOne(
            { _id: objectId }, // Find the announcement by ID
            { $set: updateData } // Update the fields with new data
        );

        // Check if the update was successful
        if (result.modifiedCount > 0) {
            return res.send('<script>alert("Announcement updated successfully!"); window.location="/ann";</script>');
        } else {
            return res.send('<script>alert("No changes were made!"); window.location="/ann";</script>');
        }
    } catch (err) {
        console.error("Error updating announcement:", err);
        res.status(500).send('<script>alert("Error updating the announcement. Please try again."); window.location="/ann";</script>');
    }
});

// Delete an announcement
app.post("/deleteAnn/:id", async (req, res) => {
    try {
        // Delete the announcement from the database using ObjectId
        await db.collection("announcements").deleteOne({ _id: new ObjectId(req.params.id) });
        
        // Redirect to the announcements page after deletion
        res.redirect("/ann");
    } catch (err) {
        console.error("❌ Error deleting announcement:", err.message);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/ann";</script>');
    }
});

app.post("/add-resident", async (req, res) => {
    try {
        const { 
            firstName, middleName, lastName, extName, position, houseNo, purok, role, 
            priority, priorityType, bDay, bMonth, bYear, birthPlace, gender, 
            civilStatus, precinct, phone, email, headId, soloParent, pwd, indigent 
        } = req.body;

        if (!firstName || !lastName || !houseNo || !purok || !role) {
            return res.send('<script>alert("Please fill out all required fields!"); window.location="/rsd";</script>');
        }

        const birthDate = new Date(`${bYear}-${bMonth}-${bDay}`);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        const monthDiff = today.getMonth() - birthDate.getMonth();
        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
            age--;
        }

        let username = null;
        let password = null;
        let shouldSendEmail = true;

        const officialPositions = [
            "Punong Barangay", "Barangay Kagawad", "Barangay Secretary", 
            "Barangay Treasurer", "Barangay BHW", "Barangay BIC", 
            "Barangay BNS", "Barangay BPO", "Barangay Clerk", "Barangay Worker"
        ];

        const access = officialPositions.includes(position) ? 1 : 0;

        if (age > 15) {
            const generateRandomPassword = () => {
                const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+";
                let password = "";
                for (let i = 0; i < 12; i++) {
                    password += chars.charAt(Math.floor(Math.random() * chars.length));
                }
                return password;
            };

            password = generateRandomPassword();

            const generateUsername = (firstName, middleName, lastName, bDay, bYear) => {
                const firstPart = firstName.charAt(0).toLowerCase() + firstName.slice(-1).toLowerCase();
                let middlePart = "";
                if (middleName) {
                    middlePart = middleName.charAt(0).toLowerCase() + middleName.slice(-1).toLowerCase();
                } else {
                    middlePart = lastName.charAt(0).toLowerCase() + lastName.slice(-1).toLowerCase();
                }
                const lastNameLower = lastName.toLowerCase();
                return `${firstPart}${middlePart}.${lastNameLower}${bDay.padStart(2, '0')}${bYear.slice(-2)}`;
            };

            username = generateUsername(firstName, middleName, lastName, bDay, bYear);
        } else {
            shouldSendEmail = false;
        }

        const isChecked = (value) => (value ? "YES" : "");
        let finalIndigent = isChecked(indigent);

        if (role === "Member" && headId) {
            const headResident = await db.collection("resident").findOne({ _id: new ObjectId(headId) });
            if (headResident && headResident.indigent === "YES") {
                finalIndigent = "YES";
            }
        }

        const newResident = {
            firstName, middleName, lastName, extName, position, houseNo, purok, role,
            priority, priorityType, bDay, bMonth, bYear, birthPlace, gender, 
            civilStatus, precinct, phone, email, username, password,
            access,
            archive: 0, headId,
            soloParent: isChecked(soloParent),
            pwd: isChecked(pwd),
            indigent: finalIndigent,
            createdAt: new Date(),
            updatedAt: null
        };

        await db.collection("resident").insertOne(newResident);

        if (shouldSendEmail) {
            let recipientEmail = email;

            if (!email && headId) {
                const headResident = await db.collection("resident").findOne({ _id: new ObjectId(headId) });
                if (headResident && headResident.email) {
                    recipientEmail = headResident.email;
                }
            }

            if (recipientEmail) {
                const mailOptions = {
                    from: 'johnniebre1995@gmail.com',
                    to: recipientEmail,
                    subject: "Your Resident Account Details",
                    text: `Dear ${firstName},\n\nYour resident account has been created.\nUsername: ${username}\nPassword: ${password}\n\nPlease keep your credentials secure.\n\nThank you.`,
                    html: `<p>Dear <strong>${firstName}</strong>,</p>
                           <p>Your resident account has been created.</p>
                           <p><strong>Username:</strong> ${username}</p>
                           <p><strong>Password:</strong> ${password}</p>
                           <p>Please keep your credentials secure.</p>
                           <p>Thank you.</p>`,
                };

                await transporter.sendMail(mailOptions);
                console.log(`Email sent to ${recipientEmail}`);
            }
        }

        res.send('<script>alert("Resident added successfully!"); window.location="/rsd";</script>');

    } catch (err) {
        console.error("Error adding resident:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/rsd";</script>');
    }
});


app.get("/arcRsd", isLogin, async (req, res) => {
    try {
        const residents = await db.collection("resident")
            .find({ archive: { $in: [1, "1"] } })
            .sort({ firstName: 1 })
            .toArray();

        const households = await db.collection("household")
            .find({ archive: { $in: [0, "0"] } })
            .toArray();

        const families = await db.collection("family")
            .find({ archive: { $in: [0, "0"] } })
            .toArray();

        // Map household and family data
        const householdMap = new Map();
        households.forEach(household => {
            householdMap.set(String(household._id), { houseNo: household.houseNo, purok: household.purok });
        });

        const familyMap = new Map();
        families.forEach(family => {
            familyMap.set(String(family._id), { poverty: family.poverty });
        });

        // Process residents
        residents.forEach(resident => {
            // Get household details
            const householdData = householdMap.get(String(resident.householdId)) || { houseNo: "-", purok: "-" };
            resident.houseNo = householdData.houseNo;
            resident.purok = householdData.purok;

            // Get family details
            const familyData = familyMap.get(String(resident.familyId)) || { poverty: "No Income" };
            resident.familyPoverty = familyData.poverty;
        }); 

        // Get total counts from actual collections
        const totalHouseholds = households.length;
        const totalFamilies = families.length;
        const totalInhabitants = residents.length;
        const totalVoters = residents.filter(resident => resident.precinct === "Registered Voter").length;

        res.render("rsdArc", {
            layout: "layout",
            title: "Archive",
            activePage: "rsd",
            residents,
            totalHouseholds,
            totalFamilies,
            totalInhabitants,
            totalVoters,
            titlePage : "Records of INHABITANTS",
            moment
        });
    } catch (err) {
        console.error("❌ Error fetching residents:", err);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});


app.get("/rsd", isLogin, async (req, res) => {
    try {
        const residents = await db.collection("resident")
            .find({ archive: { $in: [0, "0"] } })
            .sort({ firstName: 1 })
            .toArray();

        const households = await db.collection("household")
            .find({ archive: { $in: [0, "0"] } })
            .toArray();

        const families = await db.collection("family")
            .find({ archive: { $in: [0, "0"] } })
            .toArray();

        // Map household and family data
        const householdMap = new Map();
        households.forEach(household => {
            householdMap.set(String(household._id), { houseNo: household.houseNo, purok: household.purok });
        });

        const familyMap = new Map();
        families.forEach(family => {
            familyMap.set(String(family._id), { poverty: family.poverty });
        });

        // Process residents
        residents.forEach(resident => {
            // Get household details
            const householdData = householdMap.get(String(resident.householdId)) || { houseNo: "-", purok: "-" };
            resident.houseNo = householdData.houseNo;
            resident.purok = householdData.purok;

            // Get family details
            const familyData = familyMap.get(String(resident.familyId)) || { poverty: "No Income" };
            resident.familyPoverty = familyData.poverty;
        }); 

        // Get total counts from actual collections
        const totalHouseholds = households.length;
        const totalFamilies = families.length;
        const totalInhabitants = residents.length;
        const totalVoters = residents.filter(resident => resident.precinct === "Registered Voter").length;

        res.render("rsd", {
            layout: "layout",
            title: "Residents",
            activePage: "rsd",
            residents,
            totalHouseholds,
            totalFamilies,
            totalInhabitants,
            totalVoters,
            titlePage : "Records of INHABITANTS",
            moment
        });
    } catch (err) {
        console.error("❌ Error fetching residents:", err);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});


app.get("/prior", isLogin, async (req, res) => {
  try {
    const residentRaw = await db.collection("resident")
  .find({ archive: { $in: [0, "0"] } }) // no $or here!
  .sort({ firstName: 1 })
  .toArray();

    const households = await db.collection("household")
      .find({ archive: { $in: [0, "0"] } })
      .toArray();

    const families = await db.collection("family")
      .find({ archive: { $in: [0, "0"] } })
      .toArray();

    // Function to calculate age from birthdate (Handles Month Names)
    function calculateAge(bMonth, bDay, bYear) {
      if (!bMonth || !bDay || !bYear) return 0;

      // Convert month name to number if needed
      const monthNumber = isNaN(bMonth) ? moment().month(bMonth).format("M") : bMonth;
      return moment().diff(`${bYear}-${monthNumber}-${bDay}`, 'years');
    }

    // ✅ Add senior citizens (>= 60) to the filtered set
    const residents = residentRaw.filter(r =>
      calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 ||
      r.pregnant === "on" || r.pregnant === "Yes" ||
      r.pwd === "on" || r.pwd === "Yes" ||
      r.soloParent === "on" || r.soloParent === "Yes"
    );

    // Map household and family data
    const householdMap = new Map();
    households.forEach(household => {
      householdMap.set(String(household._id), { houseNo: household.houseNo, purok: household.purok });
    });

    const familyMap = new Map();
    families.forEach(family => {
      familyMap.set(String(family._id), { poverty: family.poverty });
    });

    // Process residents
    residents.forEach(resident => {
      const householdData = householdMap.get(String(resident.householdId)) || { houseNo: "-", purok: "-" };
      resident.houseNo = householdData.houseNo;
      resident.purok = householdData.purok;

      const familyData = familyMap.get(String(resident.familyId)) || { poverty: "No Income" };
      resident.familyPoverty = familyData.poverty;
    });

    // Get total counts
    const totalHouseholds = households.length;
    const totalFamilies = families.length;
    const totalInhabitants = residents.length;
    const totalVoters = residents.filter(resident => resident.precinct === "Registered Voter").length;

    res.render("prior", {
      layout: "layout",
      title: "Residents",
      activePage: "rsd",
      residents,
      totalHouseholds,
      totalFamilies,
      totalInhabitants,
      totalVoters,
      titlePage: "Priority Groups List",
      moment
    });
  } catch (err) {
    console.error("❌ Error fetching residents:", err);
    res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
  }
});

app.get("/rsdD", isLogin, async (req, res) => {
    try {
        // --- STEP 1: Filter Households for "Dike" Purok ---
        const dikeHouseholds = await db.collection("household")
            .find({ archive: { $in: [0, "0"] }, purok: "Dike" }) // Filter for active households in "Dike"
            .toArray();

        // Extract IDs of "Dike" households
        const dikeHouseholdIds = dikeHouseholds.map(h => h._id.toString());

        // --- STEP 2: Filter Residents using "Dike" household IDs ---
        const residents = await db.collection("resident")
            .find({
                archive: { $in: [0, "0"] },
                householdId: { $in: dikeHouseholdIds.map(id => new ObjectId(id)) } // Ensure ObjectIds for query
            })
            .sort({ firstName: 1 })
            .toArray();

        // --- STEP 3: Filter Families using "Dike" household IDs ---
        const families = await db.collection("family")
            .find({
                archive: { $in: [0, "0"] },
                householdId: { $in: dikeHouseholdIds.map(id => new ObjectId(id)) } // Ensure ObjectIds for query
            })
            .toArray();

        // Map household data (only for Dike households now)
        const householdMap = new Map();
        dikeHouseholds.forEach(household => {
            householdMap.set(String(household._id), { houseNo: household.houseNo, purok: household.purok });
        });

        // Map family data (only for families in Dike households now)
        const familyMap = new Map();
        families.forEach(family => {
            familyMap.set(String(family._id), { poverty: family.poverty });
        });

        // Process residents
        residents.forEach(resident => {
            // Get household details from the Dike households map
            const householdData = householdMap.get(String(resident.householdId)) || { houseNo: "-", purok: "-" };
            resident.houseNo = householdData.houseNo;
            resident.purok = householdData.purok;

            // Get family details from the Dike families map
            const familyData = familyMap.get(String(resident.familyId)) || { poverty: "No Income" };
            resident.familyPoverty = familyData.poverty;
        });

        // Get total counts from the filtered data
        const totalHouseholds = dikeHouseholds.length; // Count of Dike households
        const totalFamilies = families.length; // Count of families in Dike households
        const totalInhabitants = residents.length; // Count of residents in Dike households
        const totalVoters = residents.filter(resident => resident.precinct === "Registered Voter").length; // Voters in Dike households

        res.render("rsd", {
            layout: "layout",
            title: "Residents (Dike Purok)", // Updated title
            activePage: "rsd",
            residents,
            totalHouseholds,
            totalFamilies,
            totalInhabitants,
            totalVoters,
            titlePage : "Residents from Purok Dike"
        });
    } catch (err) {
        console.error("❌ Error fetching Dike residents:", err);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/rsdC", isLogin, async (req, res) => {
    try {
        // --- STEP 1: Filter Households for "Dike" Purok ---
        const dikeHouseholds = await db.collection("household")
            .find({ archive: { $in: [0, "0"] }, purok: "Cantarilla" }) // Filter for active households in "Dike"
            .toArray();

        // Extract IDs of "Dike" households
        const dikeHouseholdIds = dikeHouseholds.map(h => h._id.toString());

        // --- STEP 2: Filter Residents using "Dike" household IDs ---
        const residents = await db.collection("resident")
            .find({
                archive: { $in: [0, "0"] },
                householdId: { $in: dikeHouseholdIds.map(id => new ObjectId(id)) } // Ensure ObjectIds for query
            })
            .sort({ firstName: 1 })
            .toArray();

        // --- STEP 3: Filter Families using "Dike" household IDs ---
        const families = await db.collection("family")
            .find({
                archive: { $in: [0, "0"] },
                householdId: { $in: dikeHouseholdIds.map(id => new ObjectId(id)) } // Ensure ObjectIds for query
            })
            .toArray();

        // Map household data (only for Dike households now)
        const householdMap = new Map();
        dikeHouseholds.forEach(household => {
            householdMap.set(String(household._id), { houseNo: household.houseNo, purok: household.purok });
        });

        // Map family data (only for families in Dike households now)
        const familyMap = new Map();
        families.forEach(family => {
            familyMap.set(String(family._id), { poverty: family.poverty });
        });

        // Process residents
        residents.forEach(resident => {
            // Get household details from the Dike households map
            const householdData = householdMap.get(String(resident.householdId)) || { houseNo: "-", purok: "-" };
            resident.houseNo = householdData.houseNo;
            resident.purok = householdData.purok;

            // Get family details from the Dike families map
            const familyData = familyMap.get(String(resident.familyId)) || { poverty: "No Income" };
            resident.familyPoverty = familyData.poverty;
        });

        // Get total counts from the filtered data
        const totalHouseholds = dikeHouseholds.length; // Count of Dike households
        const totalFamilies = families.length; // Count of families in Dike households
        const totalInhabitants = residents.length; // Count of residents in Dike households
        const totalVoters = residents.filter(resident => resident.precinct === "Registered Voter").length; // Voters in Dike households

        res.render("rsd", {
            layout: "layout",
            title: "Cantarilla", // Updated title
            activePage: "rsd",
            residents,
            totalHouseholds,
            totalFamilies,
            totalInhabitants,
            totalVoters,
            titlePage : "Residents from Purok Cantarilla"
        });
    } catch (err) {
        console.error("❌ Error fetching Dike residents:", err);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/rsdP", isLogin, async (req, res) => {
    try {
        // --- STEP 1: Filter Households for "Dike" Purok ---
        const dikeHouseholds = await db.collection("household")
            .find({ archive: { $in: [0, "0"] }, purok: "Perigola" }) // Filter for active households in "Dike"
            .toArray();

        // Extract IDs of "Dike" households
        const dikeHouseholdIds = dikeHouseholds.map(h => h._id.toString());

        // --- STEP 2: Filter Residents using "Dike" household IDs ---
        const residents = await db.collection("resident")
            .find({
                archive: { $in: [0, "0"] },
                householdId: { $in: dikeHouseholdIds.map(id => new ObjectId(id)) } // Ensure ObjectIds for query
            })
            .sort({ firstName: 1 })
            .toArray();

        // --- STEP 3: Filter Families using "Dike" household IDs ---
        const families = await db.collection("family")
            .find({
                archive: { $in: [0, "0"] },
                householdId: { $in: dikeHouseholdIds.map(id => new ObjectId(id)) } // Ensure ObjectIds for query
            })
            .toArray();

        // Map household data (only for Dike households now)
        const householdMap = new Map();
        dikeHouseholds.forEach(household => {
            householdMap.set(String(household._id), { houseNo: household.houseNo, purok: household.purok });
        });

        // Map family data (only for families in Dike households now)
        const familyMap = new Map();
        families.forEach(family => {
            familyMap.set(String(family._id), { poverty: family.poverty });
        });

        // Process residents
        residents.forEach(resident => {
            // Get household details from the Dike households map
            const householdData = householdMap.get(String(resident.householdId)) || { houseNo: "-", purok: "-" };
            resident.houseNo = householdData.houseNo;
            resident.purok = householdData.purok;

            // Get family details from the Dike families map
            const familyData = familyMap.get(String(resident.familyId)) || { poverty: "No Income" };
            resident.familyPoverty = familyData.poverty;
        });

        // Get total counts from the filtered data
        const totalHouseholds = dikeHouseholds.length; // Count of Dike households
        const totalFamilies = families.length; // Count of families in Dike households
        const totalInhabitants = residents.length; // Count of residents in Dike households
        const totalVoters = residents.filter(resident => resident.precinct === "Registered Voter").length; // Voters in Dike households

        res.render("rsd", {
            layout: "layout",
            title: "Perigola", // Updated title
            activePage: "rsd",
            residents,
            totalHouseholds,
            totalFamilies,
            totalInhabitants,
            totalVoters,
            titlePage : "Residents from Purok Perigola"
        });
    } catch (err) {
        console.error("❌ Error fetching Dike residents:", err);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/rsdB", isLogin, async (req, res) => {
    try {
        // --- STEP 1: Filter Households for "Dike" Purok ---
        const dikeHouseholds = await db.collection("household")
            .find({ archive: { $in: [0, "0"] }, purok: "Bagong Daan" }) // Filter for active households in "Dike"
            .toArray();

        // Extract IDs of "Dike" households
        const dikeHouseholdIds = dikeHouseholds.map(h => h._id.toString());

        // --- STEP 2: Filter Residents using "Dike" household IDs ---
        const residents = await db.collection("resident")
            .find({
                archive: { $in: [0, "0"] },
                householdId: { $in: dikeHouseholdIds.map(id => new ObjectId(id)) } // Ensure ObjectIds for query
            })
            .sort({ firstName: 1 })
            .toArray();

        // --- STEP 3: Filter Families using "Dike" household IDs ---
        const families = await db.collection("family")
            .find({
                archive: { $in: [0, "0"] },
                householdId: { $in: dikeHouseholdIds.map(id => new ObjectId(id)) } // Ensure ObjectIds for query
            })
            .toArray();

        // Map household data (only for Dike households now)
        const householdMap = new Map();
        dikeHouseholds.forEach(household => {
            householdMap.set(String(household._id), { houseNo: household.houseNo, purok: household.purok });
        });

        // Map family data (only for families in Dike households now)
        const familyMap = new Map();
        families.forEach(family => {
            familyMap.set(String(family._id), { poverty: family.poverty });
        });

        // Process residents
        residents.forEach(resident => {
            // Get household details from the Dike households map
            const householdData = householdMap.get(String(resident.householdId)) || { houseNo: "-", purok: "-" };
            resident.houseNo = householdData.houseNo;
            resident.purok = householdData.purok;

            // Get family details from the Dike families map
            const familyData = familyMap.get(String(resident.familyId)) || { poverty: "No Income" };
            resident.familyPoverty = familyData.poverty;
        });

        // Get total counts from the filtered data
        const totalHouseholds = dikeHouseholds.length; // Count of Dike households
        const totalFamilies = families.length; // Count of families in Dike households
        const totalInhabitants = residents.length; // Count of residents in Dike households
        const totalVoters = residents.filter(resident => resident.precinct === "Registered Voter").length; // Voters in Dike households

        res.render("rsd", {
            layout: "layout",
            title: "Bagong Daan", // Updated title
            activePage: "rsd",
            residents,
            totalHouseholds,
            totalFamilies,
            totalInhabitants,
            totalVoters,
            titlePage : "Residents from Purok Bagong Daan"
        });
    } catch (err) {
        console.error("❌ Error fetching Dike residents:", err);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/rsdS", isLogin, async (req, res) => {
    try {
        // --- STEP 1: Filter Households for "Dike" Purok ---
        const dikeHouseholds = await db.collection("household")
            .find({ archive: { $in: [0, "0"] }, purok: "Shortcut" }) // Filter for active households in "Dike"
            .toArray();

        // Extract IDs of "Dike" households
        const dikeHouseholdIds = dikeHouseholds.map(h => h._id.toString());

        // --- STEP 2: Filter Residents using "Dike" household IDs ---
        const residents = await db.collection("resident")
            .find({
                archive: { $in: [0, "0"] },
                householdId: { $in: dikeHouseholdIds.map(id => new ObjectId(id)) } // Ensure ObjectIds for query
            })
            .sort({ firstName: 1 })
            .toArray();

        // --- STEP 3: Filter Families using "Dike" household IDs ---
        const families = await db.collection("family")
            .find({
                archive: { $in: [0, "0"] },
                householdId: { $in: dikeHouseholdIds.map(id => new ObjectId(id)) } // Ensure ObjectIds for query
            })
            .toArray();

        // Map household data (only for Dike households now)
        const householdMap = new Map();
        dikeHouseholds.forEach(household => {
            householdMap.set(String(household._id), { houseNo: household.houseNo, purok: household.purok });
        });

        // Map family data (only for families in Dike households now)
        const familyMap = new Map();
        families.forEach(family => {
            familyMap.set(String(family._id), { poverty: family.poverty });
        });

        // Process residents
        residents.forEach(resident => {
            // Get household details from the Dike households map
            const householdData = householdMap.get(String(resident.householdId)) || { houseNo: "-", purok: "-" };
            resident.houseNo = householdData.houseNo;
            resident.purok = householdData.purok;

            // Get family details from the Dike families map
            const familyData = familyMap.get(String(resident.familyId)) || { poverty: "No Income" };
            resident.familyPoverty = familyData.poverty;
        });

        // Get total counts from the filtered data
        const totalHouseholds = dikeHouseholds.length; // Count of Dike households
        const totalFamilies = families.length; // Count of families in Dike households
        const totalInhabitants = residents.length; // Count of residents in Dike households
        const totalVoters = residents.filter(resident => resident.precinct === "Registered Voter").length; // Voters in Dike households

        res.render("rsd", {
            layout: "layout",
            title: "Shortcut", // Updated title
            activePage: "rsd",
            residents,
            totalHouseholds,
            totalFamilies,
            totalInhabitants,
            totalVoters,
            titlePage : "Residents from Purok Shortcut"
        });
    } catch (err) {
        console.error("❌ Error fetching Dike residents:", err);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/rsdH", isLogin, async (req, res) => {
    try {
        // --- STEP 1: Filter Households for "Dike" Purok ---
        const dikeHouseholds = await db.collection("household")
            .find({ archive: { $in: [0, "0"] }, purok: "Maharlika Highway" }) // Filter for active households in "Dike"
            .toArray();

        // Extract IDs of "Dike" households
        const dikeHouseholdIds = dikeHouseholds.map(h => h._id.toString());

        // --- STEP 2: Filter Residents using "Dike" household IDs ---
        const residents = await db.collection("resident")
            .find({
                archive: { $in: [0, "0"] },
                householdId: { $in: dikeHouseholdIds.map(id => new ObjectId(id)) } // Ensure ObjectIds for query
            })
            .sort({ firstName: 1 })
            .toArray();

        // --- STEP 3: Filter Families using "Dike" household IDs ---
        const families = await db.collection("family")
            .find({
                archive: { $in: [0, "0"] },
                householdId: { $in: dikeHouseholdIds.map(id => new ObjectId(id)) } // Ensure ObjectIds for query
            })
            .toArray();

        // Map household data (only for Dike households now)
        const householdMap = new Map();
        dikeHouseholds.forEach(household => {
            householdMap.set(String(household._id), { houseNo: household.houseNo, purok: household.purok });
        });

        // Map family data (only for families in Dike households now)
        const familyMap = new Map();
        families.forEach(family => {
            familyMap.set(String(family._id), { poverty: family.poverty });
        });

        // Process residents
        residents.forEach(resident => {
            // Get household details from the Dike households map
            const householdData = householdMap.get(String(resident.householdId)) || { houseNo: "-", purok: "-" };
            resident.houseNo = householdData.houseNo;
            resident.purok = householdData.purok;

            // Get family details from the Dike families map
            const familyData = familyMap.get(String(resident.familyId)) || { poverty: "No Income" };
            resident.familyPoverty = familyData.poverty;
        });

        // Get total counts from the filtered data
        const totalHouseholds = dikeHouseholds.length; // Count of Dike households
        const totalFamilies = families.length; // Count of families in Dike households
        const totalInhabitants = residents.length; // Count of residents in Dike households
        const totalVoters = residents.filter(resident => resident.precinct === "Registered Voter").length; // Voters in Dike households

        res.render("rsd", {
            layout: "layout",
            title: " Maharlika Highway", // Updated title
            activePage: "rsd",
            residents,
            totalHouseholds,
            totalFamilies,
            totalInhabitants,
            totalVoters,
            titlePage : "Residents from Purok Maharlika Highway"
        });
    } catch (err) {
        console.error("❌ Error fetching Dike residents:", err);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});


app.post("/reset-resident/:id", async (req, res) => {
  if (!db) {
    return res.status(500).json({ success: false, message: "Database not connected" });
  }

  const residentId = req.params.id;

  function generateRandomPassword() {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+";
    let password = "";
    for (let i = 0; i < 12; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  const newPassword = generateRandomPassword();

  try {
    const resident = await db.collection("resident").findOne({ _id: new ObjectId(residentId) });
    if (!resident) {
      return res.status(404).json({ success: false, message: "Resident not found" });
    }

    const result = await db.collection("resident").updateOne(
      { _id: new ObjectId(residentId) },
      { $set: { password: newPassword } }
    );

    if (result.modifiedCount === 1) {
      // ✅ Respond success immediately
      res.json({ success: true, newPassword });

      // 📧 Handle email sending in the background
      let emailToSend = resident.email;
      if (!emailToSend && resident.headId) {
        const familyHead = await db.collection("resident").findOne({ _id: new ObjectId(resident.headId) });
        emailToSend = familyHead ? familyHead.email : null;
      }

      if (emailToSend) {
        const mailOptions = {
          from: '"Barangay Valdefuente" <johnniebre1995@gmail.com>',
          to: emailToSend,
          subject: 'Password Reset',
          text: `Your new password is: ${newPassword}`,
          html: `<strong>Your new password is: ${newPassword}</strong>`,
        };

        transporter.sendMail(mailOptions).catch((emailError) => {
          console.error("Error sending email:", emailError);
        });
      } else {
        console.warn("No email found for resident or family head, skipping email send.");
      }
    } else {
      res.status(404).json({ success: false, message: "Resident not found or password not updated" });
    }
  } catch (error) {
    console.error("Error resetting password:", error);
    res.status(500).json({ success: false, message: "Internal Server Error" });
  }
});

app.post("/suspend-resident/:id", async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "Database not connected" });

    const residentId = req.params.id.trim();

    if (!ObjectId.isValid(residentId)) {
        return res.status(400).json({ success: false, message: "Invalid resident ID" });
    }

    try {
        const resident = await db.collection("resident").findOne({ _id: new ObjectId(residentId) });

        if (!resident) {
            return res.status(404).json({ success: false, message: "Resident not found" });
        }

        const result = await db.collection("resident").updateOne(
            { _id: new ObjectId(residentId) },
            { $set: { suspend: 1 } }
        );

        if (result.modifiedCount === 1) {
            // ✅ Respond success immediately
            res.json({ success: true, message: "Resident suspended successfully." });

            // 📧 Send email in the background
            if (resident.email) {
                const mailOptions = {
                    from: "johnniebre1995@gmail.com",
                    to: resident.email,
                    subject: "Account Suspension Notification",
                    text: `Dear ${resident.firstName},\n\nWe regret to inform you that your account has been suspended.\n\nThank you.`,
                    html: `<p>Dear <strong>${resident.firstName}</strong>,</p>
                           <p>We regret to inform you that your account has been <strong>suspended</strong>.</p>
                           <p>If you believe this was an error, please contact your barangay office.</p>
                           <p>Thank you.</p>`,
                };

                transporter.sendMail(mailOptions)
                    .then(() => console.log("Suspension email sent to:", resident.email))
                    .catch((emailError) => console.error("Failed to send suspension email:", emailError.message));
            }
        } else {
            res.status(404).json({ success: false, message: "Resident not found." });
        }
    } catch (error) {
        console.error("Error suspending resident:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
});

app.post("/suspend2-resident/:id", async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "Database not connected" });

    const residentId = req.params.id.trim();

    if (!ObjectId.isValid(residentId)) {
        return res.status(400).json({ success: false, message: "Invalid resident ID" });
    }

    try {
        const resident = await db.collection("resident").findOne({ _id: new ObjectId(residentId) });

        if (!resident) {
            return res.status(404).json({ success: false, message: "Resident not found" });
        }

        const result = await db.collection("resident").updateOne(
            { _id: new ObjectId(residentId) },
            { $set: { suspend: 0 } }
        );

        if (result.modifiedCount === 1) {
            // ✅ Respond success immediately
            res.json({ success: true, message: "Resident suspended successfully." });

            // 📧 Send email in the background
            if (resident.email) {
                const mailOptions = {
                    from: "johnniebre1995@gmail.com",
                    to: resident.email,
                    subject: "Account Unsuspension Notification",
                    text: `Dear ${resident.firstName},\n\nWe are happy to inform you that your account has been unsuspended.\n\nThank you.`,
                    html: `<p>Dear <strong>${resident.firstName}</strong>,</p>
                           <p>We are happy to inform you that your account has been <strong>unsuspended</strong>.</p>`,
                };

                transporter.sendMail(mailOptions)
                    .then(() => console.log("Suspension email sent to:", resident.email))
                    .catch((emailError) => console.error("Failed to send suspension email:", emailError.message));
            }
        } else {
            res.status(404).json({ success: false, message: "Resident not found." });
        }
    } catch (error) {
        console.error("Error suspending resident:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
});
app.post("/archive-resident/:id", async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "Database not connected" });

    const residentId = req.params.id.trim();

    if (!ObjectId.isValid(residentId)) {
        return res.status(400).json({ success: false, message: "Invalid resident ID" });
    }

    try {
        const resident = await db.collection("resident").findOne({ _id: new ObjectId(residentId) });

        if (!resident) {
            return res.status(404).json({ success: false, message: "Resident not found" });
        }

        const result = await db.collection("resident").updateOne(
            { _id: new ObjectId(residentId) },
            { $set: { archive: 1, suspend: 1 } }   // ✅ archive + suspend
        );

        if (result.modifiedCount === 1) {
            // ✅ Respond success immediately
            res.json({ success: true, message: "Resident archived & suspended successfully." });

            // 📧 Send email in the background
            if (resident.email) {
                const mailOptions = {
                    from: "johnniebre1995@gmail.com",
                    to: resident.email,
                    subject: "Account Archived & Suspended",
                    text: `Dear ${resident.firstName},\n\nWe regret to inform you that your account has been archived and suspended.\n\nThank you.`,
                    html: `<p>Dear <strong>${resident.firstName}</strong>,</p>
                           <p>We regret to inform you that your account has been <strong>archived and suspended</strong>.</p>
                           <p>If you believe this was an error, please contact your barangay office.</p>
                           <p>Thank you.</p>`,
                };

                transporter.sendMail(mailOptions)
                    .then(() => console.log("Archive + Suspension email sent to:", resident.email))
                    .catch((emailError) => console.error("Failed to send email:", emailError.message));
            }
        } else {
            res.status(404).json({ success: false, message: "Resident not found." });
        }
    } catch (error) {
        console.error("Error archiving resident:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
});
app.post("/archive2-resident/:id", async (req, res) => {
    if (!db) return res.status(500).json({ success: false, message: "Database not connected" });

    const residentId = req.params.id.trim();

    if (!ObjectId.isValid(residentId)) {
        return res.status(400).json({ success: false, message: "Invalid resident ID" });
    }

    try {
        const resident = await db.collection("resident").findOne({ _id: new ObjectId(residentId) });

        if (!resident) {
            return res.status(404).json({ success: false, message: "Resident not found" });
        }

        const result = await db.collection("resident").updateOne(
            { _id: new ObjectId(residentId) },
            { $set: { archive: 0, suspend: 0 } }   // ✅ archive + suspend
        );

        if (result.modifiedCount === 1) {
            // ✅ Respond success immediately
            res.json({ success: true, message: "Resident archived & suspended successfully." });

            // 📧 Send email in the background
            if (resident.email) {
                const mailOptions = {
                    from: "johnniebre1995@gmail.com",
                    to: resident.email,
                    subject: "Account Archived & Suspended",
                    text: `Dear ${resident.firstName},\n\nWe regret to inform you that your account has been archived and suspended.\n\nThank you.`,
                    html: `<p>Dear <strong>${resident.firstName}</strong>,</p>
                           <p>We regret to inform you that your account has been <strong>archived and suspended</strong>.</p>
                           <p>If you believe this was an error, please contact your barangay office.</p>
                           <p>Thank you.</p>`,
                };

                transporter.sendMail(mailOptions)
                    .then(() => console.log("Archive + Suspension email sent to:", resident.email))
                    .catch((emailError) => console.error("Failed to send email:", emailError.message));
            }
        } else {
            res.status(404).json({ success: false, message: "Resident not found." });
        }
    } catch (error) {
        console.error("Error archiving resident:", error);
        res.status(500).json({ success: false, message: "Internal Server Error" });
    }
});

app.get("/updateRsd/:id", isLogin, async (req, res) => {
    try {
        if (!db) return res.status(500).send("Database not connected");

        const residentId = req.params.id.trim();

        if (!ObjectId.isValid(residentId)) {
            return res.status(400).send("Invalid resident ID");
        }

        // Fetch the specific resident
        const resident = await db.collection("resident").findOne({ _id: new ObjectId(residentId) });

        if (!resident) {
            return res.status(404).send("Resident not found");
        }

        // Fetch all residents for the head selection
        const heads = await db.collection("resident").find().toArray();

        res.render("updateRsd", {
            resident,   // The resident being updated
            heads,      // All residents for selecting headId
            layout: "layout",
            title: "Update Resident",
            activePage: "rsd",
        });

    } catch (error) {
        console.error("Error fetching resident:", error);
        res.status(500).send("Internal Server Error");
    }
});

app.post("/update-resident/:id", async (req, res) => {
    try {
        const residentId = req.params.id;

        if (!ObjectId.isValid(residentId)) {
            return res.status(400).send("Invalid resident ID");
        }

        // Fetch existing resident data
        const existingResident = await db.collection("resident").findOne({ _id: new ObjectId(residentId) });

        if (!existingResident) {
            return res.status(404).send("Resident not found");
        }

        console.log("Existing Resident Data:", existingResident);
        console.log("New Form Data:", req.body);

        // Prepare update fields by checking differences
        const updateFields = {};

        Object.keys(req.body).forEach((key) => {
            if (req.body[key] && req.body[key] !== existingResident[key]) {
                updateFields[key] = req.body[key];
            }
        });

        // Remove the logic that updates the username when email changes

        if (Object.keys(updateFields).length === 0) {
            console.log("No changes were made.");
            return res.status(400).send("No changes were made.");
        }

        // Perform update
        const result = await db.collection("resident").updateOne(
            { _id: new ObjectId(residentId) },
            { $set: updateFields }
        );

        console.log("Resident updated successfully.");
        res.redirect(`/rsdView/${residentId}`);

    } catch (error) {
        console.error("Error updating resident:", error);
        res.status(500).send("Error updating resident");
    }
});


app.post("/upload-photo/:id", upload.single("photo"), async (req, res) => {
    try {
        console.log("Request body:", req.body); // Debugging
        console.log("Uploaded file:", req.file); // Debugging

        const residentId = req.params.id;

        if (!req.file) {
            return res.status(400).send("No file uploaded.");
        }

        const photoPath = `/uploads/${req.file.filename}`;

        await db.collection("resident").updateOne(
            { _id: new ObjectId(residentId) },
            { $set: { photo: photoPath } }
        );

        res.redirect(`/rsdView/${residentId}`);
    } catch (err) {
        console.error("Error uploading photo:", err);
        res.status(500).send("Error uploading photo.");
    }
});

app.post("/upload-my-photo", isLogin, express.json({ limit: '10mb' }), async (req, res) => {
    try {
        const { image } = req.body;
        const userId = req.session.userId;

        if (!image || !userId) {
            return res.status(400).send("Missing image or session.");
        }

        const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
        const buffer = Buffer.from(base64Data, 'base64');

        const filename = `${Date.now()}.jpg`;
        const filepath = path.join(__dirname, 'public/uploads', filename);

        fs.writeFileSync(filepath, buffer);

        await db.collection("resident").updateOne(
            { _id: new ObjectId(userId) },
            { $set: { photo: `/uploads/${filename}` } }
        );

        res.status(200).send("Photo uploaded successfully.");
    } catch (err) {
        console.error("Error uploading cropped photo:", err);
        res.status(500).send("Error uploading photo.");
    }
});



app.post("/add-business", async (req, res) => {
    try {
        const { businessName, businessType, ownerName, contactNumber, houseNo, purok, estDate } = req.body;

        // Validate required fields
        if (!businessName || !businessType || !ownerName || !houseNo || !purok || !estDate) {
            return res.send('<script>alert("Please fill out all required fields!"); window.location="/bus";</script>');
        }

        // Create new business data with a default archive value of 0
        const newBusiness = {
            businessName,
            businessType,
            ownerName,
            contactNumber,
            estDate,
            houseNo,
            purok,
            createdAt: new Date(),
            archive: 0  // Default to 0 (not archived)
        };

        // Insert new business into the database
        await db.collection("business").insertOne(newBusiness);

        // Redirect with success message
        res.send('<script>alert("Business added successfully!"); window.location="/bus";</script>');
    } catch (err) {
        console.error("Error adding business:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/bus";</script>');
    }
});


app.get("/bus", isLogin, isRsd, async (req, res) => {
    try {
        
        const residents = await db.collection("resident")
            .find({ archive: { $in: [0, "0", 1, "1"] } })
            .sort({ firstName: 1 })
            .toArray();

        const households = await db.collection("household")
            .find({ archive: { $in: [0, "0"] } })
            .toArray();

        const families = await db.collection("family")
            .find({ archive: { $in: [0, "0"] } })
            .toArray();

        // Map household and family data
        const householdMap = new Map();
        households.forEach(household => {
            householdMap.set(String(household._id), { houseNo: household.houseNo, purok: household.purok });
        });

        const familyMap = new Map();
        families.forEach(family => {
            familyMap.set(String(family._id), { poverty: family.poverty });
        });

        // Process residents
        residents.forEach(resident => {
            // Get household details
            const householdData = householdMap.get(String(resident.householdId)) || { houseNo: "-", purok: "-" };
            resident.houseNo = householdData.houseNo;
            resident.purok = householdData.purok;

            // Get family details
            const familyData = familyMap.get(String(resident.familyId)) || { poverty: "No Income" };
            resident.familyPoverty = familyData.poverty;
        }); 

        // Get total counts from actual collections
        const totalHouseholds = households.length;
        const totalFamilies = families.length;
        const totalInhabitants = residents.length;
        const totalVoters = residents.filter(resident => resident.precinct === "Registered Voter").length;

        // Fetch businesses where archive is 0, sorted by businessName
        const businesses = await db.collection("business")
            .find({ archive: { $in: [0, "0"] } })  // Filter businesses where archive is 0
            .sort({ businessName: 1 }) // Sorting by businessName in ascending order
            .toArray();

        const residentMap = new Map();
        residents.forEach(resident => {
        residentMap.set(String(resident._id), resident); // always string
        });

        businesses.forEach(business => {
        const ownerId = String(business.ownerName); // normalize
        const owner = residentMap.get(ownerId);

        if (owner) {
            business.owner = {
            _id: owner._id,
            firstName: owner.firstName,
            lastName: owner.lastName,
            phone: owner.phone,
            purok: owner.purok,
            houseNo: owner.houseNo,
            familyPoverty: owner.familyPoverty
            };
        } else {
            business.owner = null;
        }
        });

       const totalCount = businesses.length;

        // If no businesses are found, display a message
        if (businesses.length === 0) {
            return res.render("bus", { 
                layout: "layout", 
                title: "Business", 
                activePage: "bus", 
                totalCount, 
                message: "No active businesses found." // Pass a message if no businesses
            });
        }

        // Render the 'bus' view and pass the businesses data
        res.render("bus", { 
            layout: "layout", 
            title: "Business", 
            activePage: "bus",
            residents,
            totalHouseholds,
            totalFamilies,
            totalInhabitants,
            totalVoters,
            totalCount, 
            businesses // Pass the businesses data to the view
        });
    } catch (err) {
        console.error("Error fetching businesses:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.post("/update-business/:id", isLogin, async (req, res) => {
    try {
        const businessId = req.params.id;
        const { businessName, estDate, businessType, ownerName, contactNumber, houseNo, purok } = req.body;

        // Validate that required fields are provided
        if (!businessName || !estDate || !businessType || !ownerName) {
            return res.send('<script>alert("All fields are required!"); window.location="/bus";</script>');
        }

        // Check if the business ID is a valid ObjectId
        if (!ObjectId.isValid(businessId)) {
            return res.send('<script>alert("Invalid Business ID!"); window.location="/bus";</script>');
        }

        // Log the businessId and input data for debugging
        console.log("Business ID:", businessId);
        console.log("Business Data:", { businessName, estDate, businessType, ownerName, contactNumber, houseNo, purok });

        // Update the business data in the database
        const result = await db.collection("business").updateOne(
            { _id: new ObjectId(businessId) }, // Instantiate ObjectId with `new`
            { 
                $set: {
                    businessName,
                    estDate, 
                    businessType, 
                    ownerName, 
                    contactNumber, 
                    houseNo, 
                    purok,
                    updatedAt: new Date()
                }
            }
        );

        console.log("Update Result:", result); // Log the result for debugging

        // Check if any document was updated
        if (result.modifiedCount === 0) {
            return res.send('<script>alert("No changes made!"); window.location="/bus";</script>');
        }

        res.send('<script>alert("Business updated successfully!"); window.location="/bus";</script>');
    } catch (err) {
        console.error("Error updating business:", err.message);
        res.status(500).send('<script>alert("Error updating the business! Please try again."); window.location="/bus";</script>');
    }
});

app.post("/delete-business/:id", isLogin, async (req, res) => {
    try {
        const businessId = req.params.id;

        // Ensure the businessId is a valid MongoDB ObjectId
        if (!ObjectId.isValid(businessId)) {
            return res.send('<script>alert("Invalid business ID."); window.location="/bus";</script>');
        }

        // Query the business to check if it exists and is not already archived
        const business = await db.collection("business").findOne({ _id: new ObjectId(businessId) });

        if (!business) {
            return res.send('<script>alert("Business not found."); window.location="/bus";</script>');
        }

        // If the business is already archived
        if (business.archive === 1) {
            return res.send('<script>alert("This business is already archived."); window.location="/bus";</script>');
        }

        // Proceed with archiving the business
        const result = await db.collection("business").updateOne(
            { _id: new ObjectId(businessId) },
            { $set: { archive: 1 } }
        );

        if (result.modifiedCount === 0) {
            return res.send('<script>alert("Failed to archive the business. Please try again."); window.location="/bus";</script>');
        }

        res.send('<script>alert("Business archived successfully."); window.location="/bus";</script>');
    } catch (err) {
        console.error("Error archiving business:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/bus";</script>');
    }
});

app.get("/viewBus/:id", isLogin, async (req, res) => {
    try {
        const businessId = req.params.id;  // Get the business ID from the URL
        const business = await db.collection("business").findOne({ _id: new ObjectId(businessId) });

        if (!business) {
            return res.status(404).send("Business not found!");
        }

        // Render the page to display the business details
        res.render("viewBus", { 
            layout: "layout", 
            title: "Business", 
            activePage: "bus", 
            business // Pass the businesses data to the view
        })
    } catch (err) {
        console.error("Error fetching business:", err.message);
        res.status(500).send("Error fetching business.");
    }
});

app.get("/htl", isLogin, async (req, res) => {
    try {
        // Fetch hotline data where archive is 0, ordered by the 'office' field
        const hotlineData = await db.collection("hotline")
    .find({ archive: { $in: [0, "0"] } })
    .sort({ office: 1 })
    .toArray();


        // Render the page with hotline data
        res.render("htl", {
            layout: "layout",
            title: "Hotline",
            activePage: "htl",
            hotlineData: hotlineData  // Pass hotline data to EJS
        });
    } catch (err) {
        console.error("Error fetching hotline data:", err);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
});

app.get("/cnt", isLogin, async (req, res) => {
    try {
        // Fetch hotline data where archive is 0, ordered by the 'office' field
        const hotlineData = await db.collection("hotline")
    .find({ archive: { $in: [0, "0"] } })
    .sort({ office: 1 })
    .toArray();


        // Render the page with hotline data
        res.render("cnt", {
            layout: "layout",
            title: "Hotline",
            activePage: "htl",
            hotlineData: hotlineData  // Pass hotline data to EJS
        });
    } catch (err) {
        console.error("Error fetching hotline data:", err);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
});





app.post("/add-hotline", async (req, res) => {
    try {
        const { office, phone1, phone2, phone3, email, web } = req.body;

        // Validate required fields
        if (!office || !phone1) {
            return res.send('<script>alert("Please fill out all required fields!"); window.location="/htl";</script>');
        }

        // Create new hotline data with a default archive value of true
        const newHotline = {
            office,
            phone1,
            phone2,
            phone3,
            email,
            web,
            createdAt: new Date(),
            archive: 0  // Default to true (archived)
        };

        // Insert new hotline into the database
        await db.collection("hotline").insertOne(newHotline);

        // Redirect with success message
        res.send('<script>alert("Hotline added successfully!"); window.location="/htl";</script>');
    } catch (err) {
        console.error("Error adding hotline:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/htl";</script>');
    }
});

app.get("/edit-hotline/:id", isLogin, async (req, res) => {
    try {
        const hotline = await Hotline.findById(req.params.id); // Assuming you're using MongoDB
        res.render("htl", {
            layout: "layout",
            title: "Hotline",
            activePage: "dsb",
            hotlineData: [hotline],  // Pass the hotline data to the view
            editMode: true          // This flag will be used to indicate edit mode
        });
    } catch (error) {
        console.log(error);
        res.status(500).send("Error fetching hotline data.");
    }
});

app.post("/update-hotline/:id", isLogin, async (req, res) => {
    try {
        const hotlineId = req.params.id; // Get the hotline ID from the URL parameter
        const { office, phone1, phone2, phone3, email, web } = req.body; // Get data from the form

        // Validate that required fields are provided (office, phone1 are required)
        if (!office || !phone1) {
            return res.send('<script>alert("Office, Phone 1 are required!"); window.location="/htl";</script>');
        }

        // Check if the hotline ID is a valid ObjectId
        if (!ObjectId.isValid(hotlineId)) {
            return res.send('<script>alert("Invalid Hotline ID!"); window.location="/htl";</script>');
        }

        // Fetch the current hotline data from the database
        const currentHotline = await db.collection("hotline").findOne({ _id: new ObjectId(hotlineId) });

        // Log the current hotline data for comparison
        console.log("Current Hotline Data:", currentHotline);

        // Log the form data to compare
        console.log("Form Data:", { office, phone1, phone2, phone3, email, web });

        // Check if any value has changed
        let changesMade = false;
        const updatedFields = {};

        // Compare form data with current data
        if (currentHotline.office !== office) {
            updatedFields.office = office;
            changesMade = true;
        }
        if (currentHotline.phone1 !== phone1) {
            updatedFields.phone1 = phone1;
            changesMade = true;
        }
        if (currentHotline.phone2 !== phone2) {
            updatedFields.phone2 = phone2;
            changesMade = true;
        }
        if (currentHotline.phone3 !== phone3) {
            updatedFields.phone3 = phone3;
            changesMade = true;
        }
        if (currentHotline.email !== email) {
            updatedFields.email = email;
            changesMade = true;
        }
        if (currentHotline.web !== web) {
            updatedFields.web = web;
            changesMade = true;
        }

        // If no changes were made, return early
        if (!changesMade) {
            return res.send('<script>alert("No changes made!"); window.location="/htl";</script>');
        }

        // Add the timestamp for update
        updatedFields.updatedAt = new Date();

        // Perform the update in the database
        const result = await db.collection("hotline").updateOne(
            { _id: new ObjectId(hotlineId) }, // Find the document by ID
            { $set: updatedFields } // Set only the updated fields
        );

        console.log("Update Result:", result); // Log the result for debugging

        // Check if any document was updated
        if (result.modifiedCount === 0) {
            return res.send('<script>alert("No changes made!"); window.location="/htl";</script>');
        }

        res.send('<script>alert("Hotline updated successfully!"); window.location="/htl";</script>');
    } catch (err) {
        console.error("Error updating hotline:", err.message);
        res.status(500).send('<script>alert("Error updating the hotline! Please try again."); window.location="/htl";</script>');
    }
});

app.get("/archive-htl/:id", isLogin, async (req, res) => {
    try {
        const hotlineId = req.params.id; // Get the hotline ID from the URL parameter

        // Check if the hotline ID is a valid ObjectId
        if (!ObjectId.isValid(hotlineId)) {
            return res.send('<script>alert("Invalid Hotline ID!"); window.location="/htl";</script>');
        }

        // Update the status of the hotline to 1 (archived)
        const result = await db.collection("hotline").updateOne(
            { _id: new ObjectId(hotlineId) }, // Find the hotline by ID
            { $set: { archive: 1, updatedAt: new Date() } } // Set the status to archived (1)
        );

        if (result.modifiedCount === 0) {
            return res.send('<script>alert("Failed to archive the hotline!"); window.location="/htl";</script>');
        }

        res.send('<script>alert("Hotline archived successfully!"); window.location="/htl";</script>');
    } catch (err) {
        console.error("Error archiving hotline:", err.message);
        res.status(500).send('<script>alert("Error archiving the hotline! Please try again."); window.location="/htl";</script>');
    }
});
app.get("/hom", isLogin, isAnn, myReq, async (req, res) => {
    console.log("🔐 User Access Level:", req.session.access);
    console.log("📌 Session Data:", req.session);

    if (req.session.access !== 0) return res.redirect("/");

    try {
        const userId = req.session.userId;
        if (!userId) throw new Error("User ID not found in session.");

        const userObjectId = ObjectId.isValid(userId) ? new ObjectId(userId) : userId;
        console.log("👤 Logged-in User ID:", userObjectId);

        // 🔍 Check if resident has reset = 1
        const resident = await db.collection("resident").findOne({ _id: userObjectId });
        if (resident && (resident.reset === 1 || resident.reset === "1")) {
            console.log("⚠️ Reset flag found. Redirecting to /prf...");
            return res.redirect("/prf");
        }

        // Fetch Complainee Cases where logged-in user is in the "name" array
        const complaineeCases = await db.collection("complainees").find({ 
            name: { $in: [userObjectId, userId] }
        }).toArray();

        console.log("📌 Complainee Cases Found:", complaineeCases.length);

        const caseObjectIds = [...new Set(complaineeCases.map(c => c.caseId))]
            .filter(id => ObjectId.isValid(id))
            .map(id => new ObjectId(id));

        console.log("⚖️ Matched Case IDs:", caseObjectIds);

        const pendingCases = caseObjectIds.length
            ? await db.collection("cases").countDocuments({ 
                _id: { $in: caseObjectIds }, 
                status: { $regex: /^pending$/i } 
            })
            : 0;

        console.log("📌 Pending Cases Count:", pendingCases);

        res.render("hom", {
            layout: "layout",
            title: "Home",
            activePage: "home",
            pendingCases,
        });

    } catch (error) {
        console.error("❌ Error fetching pending cases:", error.message);
        res.status(500).send("Internal Server Error");
    }
});


app.get("/reqM", isLogin, isAnn, myReq, async (req, res) => {
    console.log("🔐 User Access Level:", req.session.access);
    console.log("📌 Session Data:", req.session);

    if (req.session.access !== 0) return res.redirect("/");

    try {
        const userId = req.session.userId;
        if (!userId) throw new Error("User ID not found in session.");

        // Convert userId to ObjectId if valid
        const userObjectId = ObjectId.isValid(userId) ? new ObjectId(userId) : userId;

        console.log("👤 Logged-in User ID:", userObjectId);

        // Fetch Complainee Cases where logged-in user is in the "name" array
        const complaineeCases = await db.collection("complainees").find({ 
            name: { $in: [userObjectId, userId] }  // ✅ Matches either ObjectId or string
        }).toArray();

        console.log("📌 Complainee Cases Found:", complaineeCases.length);

        // Collect unique case IDs
        const caseObjectIds = [...new Set(complaineeCases.map(c => c.caseId))]
            .filter(id => ObjectId.isValid(id))
            .map(id => new ObjectId(id));

        console.log("⚖️ Matched Case IDs:", caseObjectIds);

        // Fetch 'Pending' cases
        const pendingCases = caseObjectIds.length
            ? await db.collection("cases").countDocuments({ _id: { $in: caseObjectIds }, status: { $regex: /^pending$/i } })
            : 0;

        console.log("📌 Pending Cases Count:", pendingCases);

        res.render("reqM", {
            layout: "layout",
            title: "Home",
            activePage: "home",
            pendingCases,
        });

    } catch (error) {
        console.error("❌ Error fetching pending cases:", error.message);
        res.status(500).send("Internal Server Error");
    }
});

app.get("/mainReq", isLogin, isAnn, myReq, isRsd, async (req, res) => {
    console.log("🔐 User Access Level:", req.session.access);
    console.log("📌 Session Data:", req.session);

    if (req.session.access !== 1) return res.redirect("/");

    try {
        const userId = req.session.userId;
        if (!userId) throw new Error("User ID not found in session.");

        // Convert userId to ObjectId if valid
        const userObjectId = ObjectId.isValid(userId) ? new ObjectId(userId) : userId;

        console.log("👤 Logged-in User ID:", userObjectId);

        // Fetch Complainee Cases where logged-in user is in the "name" array
        const complaineeCases = await db.collection("complainees").find({ 
            name: { $in: [userObjectId, userId] }  // ✅ Matches either ObjectId or string
        }).toArray();

        console.log("📌 Complainee Cases Found:", complaineeCases.length);

        // Collect unique case IDs
        const caseObjectIds = [...new Set(complaineeCases.map(c => c.caseId))]
            .filter(id => ObjectId.isValid(id))
            .map(id => new ObjectId(id));

        console.log("⚖️ Matched Case IDs:", caseObjectIds);

        // Fetch 'Pending' cases
        const pendingCases = caseObjectIds.length
            ? await db.collection("cases").countDocuments({ _id: { $in: caseObjectIds }, status: { $regex: /^pending$/i } })
            : 0;

        console.log("📌 Pending Cases Count:", pendingCases);

        res.render("mainReq", {
            layout: "layout",
            title: "Home",
            activePage: "home",
            pendingCases,
        });

    } catch (error) {
        console.error("❌ Error fetching pending cases:", error.message);
        res.status(500).send("Internal Server Error");
    }
});

app.get("/terms", isLogin, isAnn, myReq, async (req, res) => {
    console.log("🔐 User Access Level:", req.session.access);
    console.log("📌 Session Data:", req.session);

    if (req.session.access !== 0) return res.redirect("/");

    try {
        const userId = req.session.userId;
        if (!userId) throw new Error("User ID not found in session.");

        // Convert userId to ObjectId if valid
        const userObjectId = ObjectId.isValid(userId) ? new ObjectId(userId) : userId;

        console.log("👤 Logged-in User ID:", userObjectId);

        // Fetch Complainee Cases where logged-in user is in the "name" array
        const complaineeCases = await db.collection("complainees").find({ 
            name: { $in: [userObjectId, userId] }  // ✅ Matches either ObjectId or string
        }).toArray();

        console.log("📌 Complainee Cases Found:", complaineeCases.length);

        // Collect unique case IDs
        const caseObjectIds = [...new Set(complaineeCases.map(c => c.caseId))]
            .filter(id => ObjectId.isValid(id))
            .map(id => new ObjectId(id));

        console.log("⚖️ Matched Case IDs:", caseObjectIds);

        // Fetch 'Pending' cases
        const pendingCases = caseObjectIds.length
            ? await db.collection("cases").countDocuments({ _id: { $in: caseObjectIds }, status: { $regex: /^pending$/i } })
            : 0;

        console.log("📌 Pending Cases Count:", pendingCases);

        res.render("terms", {
            layout: "layout",
            title: "Home",
            activePage: "home",
            pendingCases,
        });

    } catch (error) {
        console.error("❌ Error fetching pending cases:", error.message);
        res.status(500).send("Internal Server Error");
    }
});

app.get("/reqAll", isLogin, isAnn, myReq, (req, res) => {
    console.log("User Access Level:", req.session.access);  // Log the access level
    if (req.session.access !== 0) return res.redirect("/reqAll"); // If access is not 0, redirect to home
    res.render("reqAll", { layout: "layout", title: "Home", activePage: "home" });
});


app.get("/req", isLogin, isAnn, myReq, (req, res) => {
    console.log("User Access Level:", req.session.access);  // Log the access level
    if (req.session.access !== 0) return res.redirect("/"); // If access is not 0, redirect to home
    res.render("hom", { layout: "layout", title: "req", activePage: "req" });
});

app.get("/reqSuccess", isLogin, isReq, (req, res) => res.render("reqSuccess", { layout: "design", title: "Services", activePage: "reqSuccess" }));

app.post("/reqDocument", isLogin, async (req, res) => {
    const sessionUserId = req.user._id; // Getting the logged-in user ID

    try {
        console.log("Request Body: ", req.body);

        // Ensure all values are arrays, even if only one item is submitted
        let { type, qty, purpose, remarks, remarkMain } = req.body;

        type = [].concat(type);
        qty = [].concat(qty).map(Number);
        purpose = [].concat(purpose);
        remarks = [].concat(remarks || ""); // Default to empty string if undefined
        remarkMain = remarkMain || ""; // Default to empty string if not provided

        console.log("Extracted Data - type:", type, "qty:", qty, "purpose:", purpose, "remarks:", remarks, "remarkMain:", remarkMain);

        // Validate array lengths
        if (type.length !== qty.length || type.length !== purpose.length) {
            return res.status(400).send('<script>alert("Mismatch in document fields! Please try again."); window.location="/hom";</script>');
        }

        // Ensure required fields are filled
        if (!type.length || !qty.length || !purpose.length) {
            return res.status(400).send('<script>alert("Please fill out all required fields."); window.location="/hom";</script>');
        }

        // Generate tracking reference (TR) components
        const year = new Date().getFullYear().toString().slice(-2); // Last two digits of the year
        const month = String(new Date().getMonth() + 1).padStart(2, "0"); // Two-digit month
        const requestByLastTwo = sessionUserId.toString().slice(-2); // Last two characters of requestBy _id

        // Create a new request entry with remarkMain
        const newRequest = {
            createdAt: new Date(),
            updatedAt: new Date(),
            status: "Pending",
            requestBy: new ObjectId(sessionUserId),
            archive: 0,
            remarkMain: remarkMain // Store remarkMain in request
        };

        const result = await db.collection("request").insertOne(newRequest);
        const reqId = result.insertedId;
        const requestIdLastTwo = reqId.toString().slice(-2); // Last two characters of request._id

        // Generate 'tr' (tracking reference)
        const tr = `${year}${month}${requestByLastTwo}${requestIdLastTwo}`;

        // Update the request with 'tr'
        await db.collection("request").updateOne(
            { _id: reqId },
            { $set: { tr } }
        );

        // Fetch resident's data
        const resident = await db.collection("resident").findOne({ _id: new ObjectId(sessionUserId) });
        const residentIndigent = resident ? resident.indigent : "";

        // ✅ Insert each document as a separate record with the correct status
        let allApproved = true; // Track if all documents are "Approved"

        const documentPromises = type.map((docType, index) => {
            let status = "Pending";

            if (docType === "Barangay Clearance" || docType === "Good Moral") {
                status = "Pending";
            } else if (docType === "Barangay Indigency") {
                status = (residentIndigent === "YES") ? "Pending" : "Pending";
            }

            // Check if all documents are "Approved"
            if (status !== "Approved") {
                allApproved = false;
            }

            return db.collection("document").insertOne({
                reqId: reqId,
                remarks: remarks[index] || "",
                type: docType,
                qty: qty[index] || 1,
                purpose: purpose[index] || "",
                status: status,
                createdAt: new Date(),
                updatedAt: new Date(),
                requestBy: new ObjectId(sessionUserId)
            });
        });

        await Promise.all(documentPromises);

        // ✅ If all documents are "Approved", update request.status to "Processing"
        if (allApproved) {
            await db.collection("request").updateOne(
                { _id: reqId },
                { $set: { status: "Processing" } }
            );
        }
        
        // Redirect to success page
        res.redirect("/reqSuccess");

        // Send email notification if resident has an email
        if (resident && resident.email) {
        const mailOptions = {
            from: '"Barangay Valdefuente" <johnniebre1995@gmail.com>',
            to: resident.email,
            subject: 'Document Request Submitted Successfully',
            html: `
            <p style="font-size: 24px; font-weight: 500; color: green;">AWESOME</p>
            <p style="font-size: 18px; margin: 0; text-align: center;">Your request has been submitted successfully!</p>
            <br>
            <div style="font-size: 14px; text-align: center; font-weight: 500;">
                The Barangay Secretary will review your request within 24 hours on business days and will notify you via email regarding its status. Weekends are excluded.
            </div>
            `,
        };

        try {
            await transporter.sendMail(mailOptions);
            console.log('Email sent to:', resident.email);
        } catch (emailError) {
            console.error('Error sending email:', emailError);
        }
        }

    } catch (err) {
        console.error("Error inserting request or document:", err);
        res.status(500).send('<script>alert("Error inserting request or document! Please try again."); window.location="/hom";</script>');
    }
});

app.get("/api/residents", async (req, res) => {
    try {
        const residents = await db.collection("resident").find({}).toArray();
        res.json(residents);
    } catch (error) {
        console.error("Error fetching residents:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});


app.get("/srv", isLogin, isReq, (req, res) => res.render("srv", { layout: "layout", title: "Services", activePage: "srv" }));
app.get("/ovv", isLogin, isReq, (req, res) => res.render("ovv", { layout: "layout", title: "Overview", activePage: "ovv" }));
app.get("/ovvB", isLogin, isReq, (req, res) => res.render("ovvB", { layout: "layout", title: "Clearance", activePage: "ovvB" }));
app.get("/ovvI", isLogin, isReq, (req, res) => res.render("ovvI", { layout: "layout", title: "Indigency", activePage: "ovvI" }));
app.get("/ovvR", isLogin, isReq, (req, res) => res.render("ovvR", { layout: "layout", title: "Residency", activePage: "ovvR" }));
app.get("/ovvG", isLogin, isReq, (req, res) => res.render("ovvG", { layout: "layout", title: "Good Moral", activePage: "ovvG" }));
app.get("/ovvC", isLogin, isReq, isRsd, (req, res) => res.render("ovvC", { layout: "layout", title: "Certification", activePage: "ovvC" }));


app.get("/srvAll", isLogin, isReq, (req, res) => res.render("srvAll", { layout: "layout", title: "Services", activePage: "srv" }));
app.get('/srvView/:id', isLogin, async (req, res) => {
    try {
        const requestId = req.params.id;

        if (!ObjectId.isValid(requestId)) {
            return res.status(400).send("Invalid Request ID");
        }

        const request = await db.collection("request")
            .findOne({ _id: new ObjectId(requestId), archive: { $in: [0, "0"] } });

        if (!request) {
            return res.status(404).send("Request not found");
        }

        const resident = await db.collection("resident")
            .findOne({ _id: new ObjectId(request.requestBy) });

        if (!resident) {
            return res.status(404).send("Resident not found");
        }

        // ✅ Fetch household using resident.householdId
        const household = await db.collection("household")
            .findOne({ _id: new ObjectId(resident.householdId) });

        // ✅ Fetch family using resident.familyId
        const family = await db.collection("family")
            .findOne({ _id: new ObjectId(resident.familyId) });

        // ✅ Fetch cases where the resident is either a complainant or a respondent
        const cases = await db.collection("cases").find({
            $or: [
                { respondents: new ObjectId(resident._id), archive: { $in: [0, "0"]}  },
                { complainants: new ObjectId(resident._id), archive: { $in: [0, "0"]}  }
            ]
        }).toArray();

        console.log("🔍 Cases Retrieved:", cases);

        // ✅ Extract all unique complainant & respondent IDs
        const allPersonIds = [...new Set(cases.flatMap(c => [...c.respondents,...c.complainants]))];

        // ✅ Fetch complainant & respondent details
        const persons = await db.collection("resident").find({
            _id: { $in: allPersonIds.map(id => new ObjectId(id)) }
        }).toArray();

        // ✅ Map resident details to case complainants/respondents
        cases.forEach(c => {
            c.respondents = c.respondents.map(rid => persons.find(p => p._id.equals(rid)) || {});
            c.complainants = c.complainants.map(rid => persons.find(p => p._id.equals(rid)) || {});
        });

        // ✅ Extract case IDs for fetching schedules
        const caseIds = cases.map(c => new ObjectId(c._id));

        const schedules = caseIds.length > 0
            ? await db.collection("schedule").find({ caseId: { $in: caseIds.map(id => id.toString()) } }).toArray()
            : [];

        // ✅ Fetch documents linked to the request
        const documents = await db.collection("document")
            .find({ reqId: request._id })
            .toArray();

        // ✅ Attach data to request
        request.resident = resident;
        request.resident.household = household; // Add household details
        request.resident.family = family; // Add family details
        request.documents = documents;
        request.cases = cases;
        request.schedules = schedules;

        const message = req.query.message || "";

        res.render('srvView', {
            request,
            layout: "layout",
            title: "View Request",
            activePage: "srv",
            message
        });
    } catch (err) {
        console.error("❌ Error in srvView route:", err.message);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
});

app.post("/yesDoc/:id", async (req, res) => {
    try {
        const docId = new ObjectId(req.params.id);
        const collection = db.collection("document");
        const requestCollection = db.collection("request");

        // Update document status to 'Approved'
        const updateDocResult = await collection.updateOne(
            { _id: docId },
            { $set: { status: "Approved" } }
        );

        if (updateDocResult.modifiedCount === 0) {
            return res.json({ success: false, message: "No document found or already approved." });
        }

        // Find the corresponding request ID from the document
        const document = await collection.findOne({ _id: docId });
        if (!document || !document.reqId) {
            return res.json({ success: false, message: "Document found but missing associated request." });
        }

        const requestId = new ObjectId(document.reqId);

        // Check the status of all documents linked to this request
        const allDocs = await collection.find({ reqId: document.reqId }).toArray();
        const pendingCount = allDocs.filter(doc => doc.status === "Pending").length;
        const approvedCount = allDocs.filter(doc => doc.status === "Approved").length;
        const declinedCount = allDocs.filter(doc => doc.status === "Declined").length;
        let newStatus = "Processing"; // Default

        if (pendingCount === 0) {
            if (approvedCount > 0 && declinedCount > 0) {
                newStatus = "For Pickup";
            } else if (approvedCount > 0 && declinedCount === 0) {
                newStatus = "For Pickup";
            } else if (declinedCount > 0 && approvedCount === 0) {
                newStatus = "Declined";
            }
        }

        // Update request status accordingly
        await requestCollection.updateOne(
            { _id: requestId },
            { $set: { status: newStatus, updatedAt: new Date(), turnAt: new Date() } }
        );

                res.json({
            success: true,
            message: "Document approved!",
            documentUpdated: true,
            requestStatus: newStatus
        });

        // Fetch resident information
        const resident = await db.collection("resident").findOne({ _id: new ObjectId(document.requestBy) });
        const familyHead = resident && resident.familyHeadId
            ? await db.collection("resident").findOne({ _id: new ObjectId(resident.familyHeadId) })
            : null;

        // Prepare the email content
        const emailDetails = {
            subject: "Document Status Update",
            html: `<p>Your requested document has been Approved: ${document.qty} copy${document.qty > 1 ? 'ies' : ''} of ${document.type} for ${document.purpose}.</p>`
        };

        let emailRecipient = null;

        if (resident && resident.email) {
            emailRecipient = resident.email;
        } else if (familyHead && familyHead.email) {
            emailRecipient = familyHead.email;
            emailDetails.html = `<p>The document request for ${resident.name} has been processed. Details:</p>` + emailDetails.html;
        }

        // Send approval email
        if (emailRecipient) {
            try {
                await transporter.sendMail({
                    from: '"Barangay Valdefuente" <johnniebre1995@gmail.com>',
                    to: emailRecipient,
                    subject: emailDetails.subject,
                    html: emailDetails.html
                });
                console.log('Approval Email sent to:', emailRecipient);
            } catch (emailError) {
                console.error('Error sending approval email:', emailError);
            }
        }

        // Send pickup notification if status is "For Pickup"
        if (newStatus === "For Pickup" && emailRecipient) {
            const pickupEmailDetails = {
                from: '"Barangay Valdefuente" <johnniebre1995@gmail.com>',
                to: emailRecipient,
                subject: "Your Documents Are Ready for Pickup",
                html: `<p>Dear ${resident ? `${resident.extName || resident.name}` : "Requester"},</p>
                       <p>Your requested document is now ready for pickup. Please proceed to the Barangay Hall.</p>
                       <p>If you are unable to personally claim it, you may authorize someone else to pick it up on your behalf.</p>
                       <p>To do so, please provide an <strong>authorization letter</strong> along with a <strong>valid ID</strong> of both the requester and the authorized person.</p>
                       <p>You can download a free authorization letter template from our system.</p>
                       <p>Thank you!</p>`
            };

            try {
                await transporter.sendMail(pickupEmailDetails);
                console.log('Pickup Email sent to:', emailRecipient);
            } catch (emailError) {
                console.error('Error sending pickup email:', emailError);
            }
        }

    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, message: "Error updating document and request status." });
    }
});

app.post("/appStat/:id", async (req, res) => {
    try {
        if (!ObjectId.isValid(req.params.id)) {
            return res.redirect(`/srvView/${req.params.id}`);
        }

        const requestId = new ObjectId(req.params.id);
        const requestCollection = db.collection("request");

        // Update request status to 'Approved'
        const updateResult = await requestCollection.updateOne(
            { _id: requestId },
            { $set: { status: "Approved", updatedAt: new Date(), turnAt: new Date() } }
        );
      
        res.redirect(`/srvView/${req.params.id}`);

        if (updateResult.modifiedCount === 0) {
            return res.redirect(`/srvView/${req.params.id}`);
        }


        // Fetch request details
        const request = await requestCollection.findOne({ _id: requestId });
        if (!request) {
            return res.redirect(`/srvView/${req.params.id}`);
        }

        // Fetch resident info
        const resident = await db.collection("resident").findOne({ _id: new ObjectId(request.requestBy) });
        const familyHead = resident?.familyHeadId
            ? await db.collection("resident").findOne({ _id: new ObjectId(resident.familyHeadId) })
            : null;
        

        // Determine email recipient
        let emailRecipient = resident?.email || familyHead?.email || null;
        if (!emailRecipient) {
            console.log("No valid email found for notification.");
            return res.redirect(`/srvView/${req.params.id}`);
        }

        // Email Content
        let emailHTML = `
            <p>Your request has been <strong>Approved</strong>.</p>
            <p>Request Reference: ${request._id}</p>
            <p>Thank you for using our system.</p>
        `;

        if (resident?.email !== emailRecipient) {
            emailHTML = `<p>The request for ${resident?.firstName || "your household member"} has been approved.</p>` + emailHTML;
        }

        const emailDetails = {
            from: '"Barangay Valdefuente" <johnniebre1995@gmail.com>',
            to: emailRecipient,
            subject: "Request Status Update - Approved",
            html: emailHTML
        };

        // Send email
        await transporter.sendMail(emailDetails);
        console.log('Approval Email sent to:', emailRecipient);

    } catch (error) {
        console.error("Error:", error);
        res.redirect(`/srvView/${req.params.id}`);
    }
});

app.post("/noDoc/:id", async (req, res) => {
    try {
        const docId = new ObjectId(req.params.id);
        const collection = db.collection("document");
        const requestCollection = db.collection("request");
        const { notes } = req.body;

        // Update document
        const updateDocResult = await collection.updateOne(
            { _id: docId },
            { $set: { status: "Declined", notes: notes || "No notes provided." } }
        );

        if (updateDocResult.modifiedCount === 0) {
            return res.json({ success: false, message: "No document found or already declined." });
        }

        // Refetch updated doc
        const document = await collection.findOne({ _id: docId });
        if (!document?.reqId) {
            return res.json({ success: false, message: "Document found but missing associated request." });
        }

        const requestId = new ObjectId(document.reqId);

        // Check sibling docs
        const allDocs = await collection.find({ reqId: document.reqId }).toArray();
        const pendingCount = allDocs.filter(d => d.status === "Pending").length;
        const approvedCount = allDocs.filter(d => d.status === "Approved").length;
        const declinedCount = allDocs.filter(d => d.status === "Declined").length;

        let newStatus = "Processing";
        if (pendingCount === 0) {
            if (approvedCount > 0 && declinedCount > 0) newStatus = "Processed";
            else if (approvedCount > 0) newStatus = "Processed";
            else if (declinedCount > 0) newStatus = "Declined";
        }

        await requestCollection.updateOne(
            { _id: requestId },
            { $set: { status: newStatus, updatedAt: new Date(), turnAt: new Date() } }
        );

        // ✅ Respond immediately to frontend
        res.json({
            success: true,
            message: "Document declined!",
            documentUpdated: true,
            requestStatus: newStatus
        });

        // 🔄 Fire-and-forget email (does not block decline success)
        (async () => {
            try {
                const resident = await db.collection("resident").findOne({ _id: new ObjectId(document.requestBy) });
                const familyHead = resident?.familyHeadId
                    ? await db.collection("resident").findOne({ _id: new ObjectId(resident.familyHeadId) })
                    : null;

                let emailHTML = `<p>${document.qty} copy${document.qty > 1 ? 'ies' : ''} of ${document.type} for ${document.purpose} has been declined.</p>`;
                emailHTML += `<p>Reason: <strong>${notes || 'No specific remarks.'}</strong></p>`;

                let emailTo = null;
                if (resident?.email) {
                    emailTo = resident.email;
                } else if (familyHead?.email) {
                    emailTo = familyHead.email;
                    emailHTML = `<p>The document request for ${resident.firstName} ${resident.lastName} has been processed. Details:</p>` + emailHTML;
                }

                if (!emailTo) {
                    console.warn("No email found for notification.");
                    return;
                }

                await transporter.sendMail({
                    from: '"Barangay Valdefuente" <johnniebre1995@gmail.com>',
                    to: emailTo,
                    subject: "Document Status Update - Declined",
                    html: emailHTML
                });

                console.log("Decline Email sent to:", emailTo);
            } catch (mailErr) {
                console.error("Email sending failed:", mailErr.message);
            }
        })();

    } catch (error) {
        console.error("Decline error:", error);
        return res.status(500).json({ success: false, message: "Error updating document and request status." });
    }
});


app.post("/release/:id", async (req, res) => {
    try {
        const requestId = new ObjectId(req.params.id);
        const requestCollection = db.collection("request");

        // Update request status
        const updateRequest = await requestCollection.updateOne(
            { _id: requestId },
            {
                $set: {
                    status: "Claimed",
                    updatedAt: new Date(),
                    successAt: new Date()
                }
            }
        );

        if (updateRequest.modifiedCount === 0) {
            return res.json({ success: false, message: "No request found or already updated." });
        }

        // Find request and resident details
        const request = await requestCollection.findOne({ _id: requestId });
        const resident = await db.collection("resident").findOne({ _id: new ObjectId(request.requestBy) });

        let message = "The document has been claimed!";
        
        res.json({ success: true, message });

        if (resident?.email) {
            const mailOptions = {
                from: 'johnniebre1995@gmail.com',
                to: resident.email,
                subject: "Your Document has been Claimed",
                html: `
                    <p>Dear <strong>${resident.firstName} ${resident.lastName}</strong>,</p>
                    <p>Your requested document has been <strong>claimed!</strong>.</p>
                    <p>Thank you.</p>
                `
            };

            try {
                await transporter.sendMail(mailOptions);
                console.log(`Email sent to ${resident.email}`);
                message += " Email notification sent.";
            } catch (emailError) {
                console.error("Error sending email:", emailError);
                message += " However, the email notification could not be sent.";
            }
        }


    } catch (error) {
        console.error("Error updating request status:", error);
        res.json({ success: false, message: "Error updating request status." });
    }
});


app.post("/cancel/:id", async (req, res) => {
    try {
        const requestId = new ObjectId(req.params.id);
        const requestCollection = db.collection("request");

        // Update request status
        const updateRequest = await requestCollection.updateOne(
            { _id: requestId },
            {
                $set: {
                    status: "Cancelled",
                    cancelAt: new Date(),
                    updatedAt: new Date()
                }
            }
        );

        if (updateRequest.modifiedCount === 0) {
            return res.json({ success: false, message: "No request found or already updated." });
        }

        // Find request and resident details
        const request = await requestCollection.findOne({ _id: requestId });
        const resident = await db.collection("resident").findOne({ _id: new ObjectId(request.requestBy) });

        let message = "The document has been cancelled!";
        
        res.json({ success: true, message });

        if (resident?.email) {
            const mailOptions = {
                from: 'johnniebre1995@gmail.com',
                to: resident.email,
                subject: "Request Cancelled",
                html: `
                    <p>Dear <strong>${resident.firstName} ${resident.lastName}</strong>,</p>
                    <p>You have successfully<strong>cancelled</strong> your request.</p>
                `
            };

            try {
                await transporter.sendMail(mailOptions);
                console.log(`Email sent to ${resident.email}`);
                message += " Email notification sent.";
            } catch (emailError) {
                console.error("Error sending email:", emailError);
                message += " However, the email notification could not be sent.";
            }
        }


    } catch (error) {
        console.error("Error updating request status:", error);
        res.json({ success: false, message: "Error updating request status." });
    }
});


app.get("/srvPrint/:id", isLogin, async (req, res) => {
    try {
        const residentId = req.params.id; // Get the resident's _id from the URL

        // Fetch the resident data from the database
        const resident = await db.collection("resident").findOne({ _id: new ObjectId(residentId) });

        if (!resident) {
            return res.status(404).send('<script>alert("Resident not found!"); window.location="/rsd";</script>');
        }

        // Calculate Age Function
        const calculateAge = (bDay, bMonth, bYear) => {
            const months = {
                January: 1,
                February: 2,
                March: 3,
                April: 4,
                May: 5,
                June: 6,
                July: 7,
                August: 8,
                September: 9,
                October: 10,
                November: 11,
                December: 12
            };

            // Ensure we are using the correct date format
            const month = months[bMonth];
            if (!month) return 0;

            const birthDateString = `${bYear}-${String(month).padStart(2, '0')}-${String(bDay).padStart(2, '0')}`;
            const birthDate = new Date(birthDateString);

            if (isNaN(birthDate)) return 0;

            const ageDifMs = Date.now() - birthDate.getTime();
            const ageDate = new Date(ageDifMs);
            return Math.abs(ageDate.getUTCFullYear() - 1970);  // Calculate age
        };

        // Render the details page with the resident's data and calculated age
        res.render("srvPrint", {
            layout: "layout",
            title: "Resident Details",
            activePage: "srv",
            resident: resident,
            calculateAge: calculateAge,  // Passing the function to the template
        });
    } catch (err) {
        console.error("Error fetching resident details:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/rsd";</script>');
    }
});

const moment = require("moment");
const { error } = require("console");


    app.get("/dsb", isLogin, sumDoc, sumReq, async (req, res) => {
        
        try {
            // Fetch data from MongoDB
            const residents = await db.collection("resident").find({ archive: { $in: ["0", 0] } }).toArray();
            const businesses = await db.collection("business").countDocuments({ archive: { $in: ["0", 0] } });
            const pendingCount = await db.collection("request").countDocuments({ 
                status: { $in: ["Pending", "Processing"] } 
            });

            const titlePage = "Barangay Valdefuente"
            

            // Total Population
            const totalPopulation = residents.length;

            
            // Total Families (Residents with role = "Head")
            const totalFamilies = await db.collection("family").countDocuments({ archive: { $in: ["0", 0] } });
            
            function formatPercentage(value) {
                return value.endsWith(".00") ? parseInt(value) : value;
            }

            // Gender Distribution
            const maleCount = residents.filter(r => r.gender?.toLowerCase() === "male").length;
            const femaleCount = residents.filter(r => r.gender?.toLowerCase() === "female").length;
            const malePercentage = totalPopulation ? formatPercentage(((maleCount / totalPopulation) * 100).toFixed(2)) : "0";
            const femalePercentage = totalPopulation ? formatPercentage(((femaleCount / totalPopulation) * 100).toFixed(2)) : "0";

            // Priority Groups
            const priorityGroups = {
                "Senior Citizen": residents.filter(r => r.priority === "Senior Citizen").length,
                "PWD": residents.filter(r => r.pwd === "on").length,
                "Solo Parent": residents.filter(r => r.soloParent === "on").length,
            };

            // Additional Counts
            const pwdCount = residents.filter(r => r.pwd === "on").length;
            const soloParentCount = residents.filter(r => r.soloParent === "on").length;
            const seniorCitizenCount = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length;
            const pregCount = residents.filter(r => r.pregnant === "on").length;
            const empCount = residents.filter(r => r.employmentStatus === "Employed" ).length;
            const emp2Count = residents.filter(r => r.employmentStatus === "Unemployed" ).length;
            const emp3Count = residents.filter(r => r.employmentStatus === "Self-Employed" ).length;
            const emp4Count = residents.filter(r => r.employmentStatus === "Student" ).length;
            const emp5Count = residents.filter(r => r.employmentStatus === "Dependent" ).length;
            const emp6Count = residents.filter(r => r.employmentStatus === "Pensioner" ).length;
            const emp7Count = residents.filter(r => r.employmentStatus === "Retired" ).length;
            const indigentCount = await db.collection("family").countDocuments({ archive: { $in: ["0", 0] }, poverty: "Indigent" });
            const nonIndigent = await db.collection("family").countDocuments({ archive: { $in: ["0", 0] }, poverty: "Non-Indigent" });
            const npoorCount = await db.collection("family").countDocuments({ archive: { $in: ["0", 0] }, poverty: "Low Income" });

            // PWD, Solo Parent, and Senior Citizen Percentages
            
            const pwdPercentage = totalPopulation ? formatPercentage(((pwdCount / totalPopulation) * 100).toFixed(2)) : "0";
            const soloParentPercentage = totalPopulation ? formatPercentage(((soloParentCount / totalPopulation) * 100).toFixed(2)) : "0";
            const seniorCitizenPercentage = totalPopulation ? formatPercentage(((seniorCitizenCount / totalPopulation) * 100).toFixed(2)) : "0";
            const pregPercentage = totalPopulation ? formatPercentage(((pregCount / totalPopulation) * 100).toFixed(2)) : "0";
            const indigentPercentage = totalFamilies ? formatPercentage(((indigentCount / totalFamilies) * 100).toFixed(2)) : "0";
            const nonIndigentPercentage = totalFamilies ? formatPercentage(((nonIndigent / totalFamilies) * 100).toFixed(2)) : "0";
            const npoorPercentage = totalFamilies ? formatPercentage(((npoorCount / totalFamilies) * 100).toFixed(2)) : "0";
            const empPercentage = totalPopulation ? formatPercentage(((empCount / totalPopulation) * 100).toFixed(2)) : "0";
            const emp2Percentage = totalPopulation ? formatPercentage(((emp2Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp3Percentage = totalPopulation ? formatPercentage(((emp3Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp4Percentage = totalPopulation ? formatPercentage(((emp4Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp5Percentage = totalPopulation ? formatPercentage(((emp5Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp6Percentage = totalPopulation ? formatPercentage(((emp6Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp7Percentage = totalPopulation ? formatPercentage(((emp7Count / totalPopulation) * 100).toFixed(2)) : "0";
            



            // Priority Groups Percentages
            const priorityGroupPercentages = {};
            Object.keys(priorityGroups).forEach(key => {
                priorityGroupPercentages[key] = totalPopulation ? ((priorityGroups[key] / totalPopulation) * 100).toFixed(2) : "0";
            });

            // Function to calculate age from birthdate (Handles Month Names)
            function calculateAge(bMonth, bDay, bYear) {
                if (!bMonth || !bDay || !bYear) return 0;

                // Convert month name to number if needed
                const monthNumber = isNaN(bMonth) ? moment().month(bMonth).format("M") : bMonth;
                return moment().diff(`${bYear}-${monthNumber}-${bDay}`, 'years');
            }

            // Age Distribution
            const ageGroups = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5).length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5).length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5).length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12).length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17).length,
                "18-29": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 29).length,
                "30-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 30 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59).length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length,
            };

            const ageGroups2 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Male").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Male").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Male").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Male").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Male").length,
                "18-29": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 29 && r.gender === "Male").length,
                "30-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 30 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Male").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Male").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Male").length,
            };

            const ageGroups3 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Female").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Female").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Female").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Female").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Female").length,
                "18-29": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 29 && r.gender === "Female").length,
                "30-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 30 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Female").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Female").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Female").length,
            };


            // Age Group Percentages
            const ageGroupPercentages = {};
            Object.keys(ageGroups).forEach(key => {
                ageGroupPercentages[key] = totalPopulation ? formatPercentage(((ageGroups[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages2 = {};
            Object.keys(ageGroups2).forEach(key => {
                ageGroupPercentages2[key] = totalPopulation ? formatPercentage(((ageGroups2[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages3 = {};
            Object.keys(ageGroups3).forEach(key => {
                ageGroupPercentages3[key] = totalPopulation ? formatPercentage(((ageGroups3[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            
            const ageGroups4 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pwd === "on").length,
                "18-29": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 29 && r.pwd === "on").length,
                "30-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 30 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pwd === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pwd === "on").length,
            };
            
            
            const ageGroups5 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pregnant === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pregnant === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pregnant === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pregnant === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pregnant === "on").length,
                "18-29": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 29 && r.pregnant === "on").length,
                "30-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 30 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pregnant === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pregnant === "on").length,
            };

                        
            const ageGroups6 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.soloParent === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.soloParent === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.soloParent === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.soloParent === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.soloParent === "on").length,
                "18-29": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 29 && r.soloParent === "on").length,
                "30-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 30 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.soloParent === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.soloParent === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.soloParent === "on").length,
            };

                        
// Age Group 7 (for reference - note correction for "Senior" as it had `r.pwd === "Employed").employmentStatus` which seems incorrect for counting employed seniors)
const ageGroups7 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Employed").length,
    "18-29years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 29 && r.employmentStatus === "Employed").length,
    "30-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 30 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Employed").length, // Corrected assumption: count of employed seniors
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Employed").length,
};

// --- New Age Group Objects ---

// Age Group 8: Unemployed
const ageGroups8 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Unemployed").length,
    "18-29": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 29 && r.employmentStatus === "Unemployed").length,
    "30-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 30 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Unemployed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Unemployed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Unemployed").length,
};


// Age Group 9: Self-Employed
const ageGroups9 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Self-Employed").length,
    "18-29years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 29 && r.employmentStatus === "Self-Employed").length,
    "30-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 30 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Self-Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Self-Employed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Self-Employed").length,
};


// Age Group 10: Student
const ageGroups10 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Student").length,
    "18-29years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 29 && r.employmentStatus === "Student").length,
    "30-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 30 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Student").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Student").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Student").length,
};

// Age Group 11: Dependent
const ageGroups11 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Dependent").length,
    "18-29years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 29 && r.employmentStatus === "Dependent").length,
    "30-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 30 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Dependent").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Dependent").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Dependent").length,
};

// Age Group 12: Retired
const ageGroups12 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Retired").length,
    "18-29years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 29 && r.employmentStatus === "Retired").length,
    "30-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 30 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Retired").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Retired").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Retired").length,
};

// Age Group 13: Pensioner
const ageGroups13 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Pensioner").length,
    "18-29years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 29 && r.employmentStatus === "Pensioner").length,
    "30-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 30 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Pensioner").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Pensioner").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Pensioner").length,
};

// Age Group 4
const ageGroupPercentages4 = {};
Object.keys(ageGroups4).forEach(key => {
    ageGroupPercentages4[key] = totalPopulation ? formatPercentage(((ageGroups4[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 5
const ageGroupPercentages5 = {};
Object.keys(ageGroups5).forEach(key => {
    ageGroupPercentages5[key] = totalPopulation ? formatPercentage(((ageGroups5[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 6
const ageGroupPercentages6 = {};
Object.keys(ageGroups6).forEach(key => {
    ageGroupPercentages6[key] = totalPopulation ? formatPercentage(((ageGroups6[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 7
const ageGroupPercentages7 = {};
Object.keys(ageGroups7).forEach(key => {
    ageGroupPercentages7[key] = totalPopulation ? formatPercentage(((ageGroups7[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 8
const ageGroupPercentages8 = {};
Object.keys(ageGroups8).forEach(key => {
    ageGroupPercentages8[key] = totalPopulation ? formatPercentage(((ageGroups8[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 9
const ageGroupPercentages9 = {};
Object.keys(ageGroups9).forEach(key => {
    ageGroupPercentages9[key] = totalPopulation ? formatPercentage(((ageGroups9[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 10
const ageGroupPercentages10 = {};
Object.keys(ageGroups10).forEach(key => {
    ageGroupPercentages10[key] = totalPopulation ? formatPercentage(((ageGroups10[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 11
const ageGroupPercentages11 = {};
Object.keys(ageGroups11).forEach(key => {
    ageGroupPercentages11[key] = totalPopulation ? formatPercentage(((ageGroups11[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 12
const ageGroupPercentages12 = {};
Object.keys(ageGroups12).forEach(key => {
    ageGroupPercentages12[key] = totalPopulation ? formatPercentage(((ageGroups12[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 13
const ageGroupPercentages13 = {};
Object.keys(ageGroups13).forEach(key => {
    ageGroupPercentages13[key] = totalPopulation ? formatPercentage(((ageGroups13[key] / totalPopulation) * 100).toFixed(2)) : "0";
});


            // Total Households (Unique Addresses: houseNo + purok)
            const uniqueHouseholds = await db.collection("household").countDocuments({ archive: { $in: ["0", 0] } });


            // SK Voters (15-30 years old with precinct)
            const skVoters = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length;

            // Registered Voters (Residents with a precinct value)
            const registeredVoters = residents.filter(r => r.precinct === "Registered Voter").length;
            
// 👇 INSERT FAMILY SIZE + POVERTY BREAKDOWN HERE

// Step 1: Group residents by familyId to get family sizes
const familySizes = await db.collection("resident").aggregate([
  { $match: { archive: { $in: ["0", 0] } } },
  { $group: { _id: "$familyId", size: { $sum: 1 } } }
]).toArray();

// Step 2: Map family sizes into ranges
function getFamilySizeRange(size) {
  if (size <= 2) return "1-2";
  if (size <= 4) return "3-4";
  if (size <= 6) return "5-6";
  if (size <= 8) return "7-8";
  return "9 & above";
}

const families = await db.collection("family").find({
    archive: { $in: ["0", 0] } // only Dike
}).toArray();

const sizeMap = Object.fromEntries(familySizes.map(f => [String(f._id), f.size]));

// result container
const povertyCounts = {
  "1-2": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "3-4": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "5-6": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "7-8": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "9 & above": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 }
};

// Variables for averages, highest, and lowest
let totalFamSize = 0, totalIncome = 0, count = 0;
let highFam = 0, highIncome = 0;

// Initialize low values to null. This signifies that no *positive* value has been encountered yet.
let lowFam = null;
let lowIncome = null;

families.forEach(fam => {
    // Ensure famSize and currentIncome are always numbers (defaulting to 0 if not valid)
    const famSize = Number(sizeMap[String(fam._id)]) || 0;
    const currentIncome = Number(fam.familyIncome) || 0;

    // Poverty breakdown (existing logic)
    // Assuming 'range' and 'povertyCounts' are defined elsewhere
        const range = getFamilySizeRange(famSize);
        if (povertyCounts[range] && povertyCounts[range][fam.poverty] !== undefined) {
        povertyCounts[range][fam.poverty] += 1;
        }

    // Totals for averages
    totalFamSize += famSize;
    totalIncome += currentIncome;
    count++;

    // Highest values (existing logic, updated for robustness)
    if (famSize > highFam) {
        highFam = famSize;
    }
    if (currentIncome > highIncome) {
        highIncome = currentIncome;
    }

    // --- REVISED LOGIC FOR LOWEST VALUES (excluding 0) ---
    // For Family Size:
    if (famSize > 0) { // Only consider positive family sizes
        if (lowFam === null || famSize < lowFam) { // If it's the first positive value OR smaller than current low
            lowFam = famSize;
        }
    }

    // For Family Income:
    if (currentIncome > 0) { // Only consider positive incomes
        if (lowIncome === null || currentIncome < lowIncome) { // If it's the first positive value OR smaller than current low
            lowIncome = currentIncome;
        }
    }
});

// --- Final adjustment for lowFam/lowIncome after the loop ---
// If no positive family size was found, default lowFam to 0. Otherwise, keep the found lowest.
lowFam = (lowFam === null) ? 0 : lowFam;
// If no positive income was found, default lowIncome to 0. Otherwise, keep the found lowest.
lowIncome = (lowIncome === null) ? 0 : lowIncome;

console.log(`Final lowFam (excluding 0): ${lowFam}, Final lowIncome (excluding 0): ${lowIncome}`);

// Final computed values
const aveFam = count > 0 ? (totalFamSize / count).toFixed(2) : 0;
const aveIncome = count > 0 ? (totalIncome / count).toFixed(2) : 0;


  const lat = 15.4869;   // Cabanatuan latitude
  const lon = 120.9730;  // Cabanatuan longitude
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;

  const response = await fetch(url);
  const weather = await response.json();

            // Render to EJS
            res.render("dsb", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb",
                weatherCode: weather.current_weather.weathercode,
                pendingCount,
                totalPopulation,
                uniqueHouseholds,
                totalFamilies,
                skVoters,
                registeredVoters,
                businesses,
                maleCount, malePercentage,
                femaleCount, femalePercentage,
                priorityGroups, priorityGroupPercentages, ageGroups, ageGroupPercentages, ageGroups2, ageGroupPercentages2, ageGroups3, ageGroupPercentages3, ageGroups4, ageGroupPercentages4, ageGroups5, ageGroupPercentages5, ageGroups6, ageGroupPercentages6, ageGroups7, ageGroupPercentages7, ageGroups8, ageGroupPercentages8, ageGroups9, ageGroupPercentages9, ageGroups10, ageGroupPercentages10, ageGroups11, ageGroupPercentages11, ageGroups12, ageGroupPercentages12, ageGroups13, ageGroupPercentages13,
                pwdCount, soloParentCount, seniorCitizenCount,indigentCount, nonIndigent, npoorCount, empCount, emp2Count, pregCount,
                 emp3Count, emp4Count, emp5Count, emp6Count, emp7Count,
                pwdPercentage, soloParentPercentage, seniorCitizenPercentage, indigentPercentage, nonIndigentPercentage, npoorPercentage, empPercentage, emp3Percentage, emp4Percentage, emp5Percentage, emp6Percentage, emp7Percentage,
                emp2Percentage, pregPercentage, titlePage,  
  povertyCounts,
  aveFam,
  aveIncome,
  highFam,
  highIncome, lowIncome
            });

        } catch (err) {
            console.error("❌ Error fetching dashboard data:", err);
            res.render("index", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb2",
                error: ""
            });
        }
    });

    
app.get("/dsbDike", isLogin, sumDoc, sumReq, async (req, res) => {
        
        try {
            const dikeStreetHouseholds = await db.collection("household").find(
                { purok: "Dike" }, // Filter households by their 'purok' field
                { _id: 1 } // Only retrieve the '_id' field for these households (makes it efficient)
            ).toArray();
            // ✅ Step 2: families with residents included
const familyData = await db.collection("family").aggregate([
  {
    $lookup: {
      from: "household",
      let: { hhId: "$householdId" },
      pipeline: [
        { $match: { $expr: { $eq: ["$_id", { $toObjectId: "$$hhId" }] } } }
      ],
      as: "household"
    }
  },
  { $unwind: "$household" },
  { $match: { "household.purok": "Dike", archive: { $in: ["0", 0] } } },
  {
    $lookup: {
      from: "resident",
      localField: "_id",
      foreignField: "familyId",
      as: "residents"
    }
  },
  {
    $addFields: {
      famSize: { $size: "$residents" },
      famIncome: { $toInt: "$familyIncome" },
      poverty: "$poverty"
    }
  }
]).toArray();

        // 2. Extract just the '_id' values into an array
            const dikeStreetHouseholdIds = dikeStreetHouseholds.map(h => h._id);

        // --- MODIFY THIS LINE (just adding one condition): ---
        // Now, fetch residents who are active (archive: 0 or "0")
        // AND whose 'householdId' is found in our 'dikeStreetHouseholdIds' array.
            const residents = await db.collection("resident").find({
                archive: { $in: ["0", 0] }, // Your existing filter for active residents
                householdId: { $in: dikeStreetHouseholdIds } // NEW: Filter by associated Dike Street households
            }).toArray();

            const businesses = await db.collection("business").countDocuments({ archive: { $in: ["0", 0] }, purok: "Dike" });
            const pendingCount = await db.collection("request").countDocuments({ 
                status: { $in: ["Pending", "Processing"] } 
            });
            

            // Total Population
            const totalPopulation = residents.length;

            const householdIdStrings = dikeStreetHouseholds.map(h => h._id.toString());

            const totalFamilies = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            $expr: { 
                $in: [{ $toString: "$householdId" }, householdIdStrings] 
            }
            });
            
            function formatPercentage(value) {
                return value.endsWith(".00") ? parseInt(value) : value;
            }

            // Gender Distribution
            const maleCount = residents.filter(r => r.gender?.toLowerCase() === "male").length;
            const femaleCount = residents.filter(r => r.gender?.toLowerCase() === "female").length;
            const malePercentage = totalPopulation ? formatPercentage(((maleCount / totalPopulation) * 100).toFixed(2)) : "0";
            const femalePercentage = totalPopulation ? formatPercentage(((femaleCount / totalPopulation) * 100).toFixed(2)) : "0";

            // Priority Groups
            const priorityGroups = {
                "Senior Citizen": residents.filter(r => r.priority === "Senior Citizen").length,
                "PWD": residents.filter(r => r.pwd === "on").length,
                "Solo Parent": residents.filter(r => r.soloParent === "on").length,
            };

            // Additional Counts
            const pwdCount = residents.filter(r => r.pwd === "on").length;
            const soloParentCount = residents.filter(r => r.soloParent === "on").length;
            const seniorCitizenCount = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length;
            const pregCount = residents.filter(r => r.pregnant === "on").length;
            const empCount = residents.filter(r => r.employmentStatus === "Employed" ).length;
            const emp2Count = residents.filter(r => r.employmentStatus === "Unemployed" ).length;
            const emp3Count = residents.filter(r => r.employmentStatus === "Self-Employed" ).length;
            const emp4Count = residents.filter(r => r.employmentStatus === "Student" ).length;
            const emp5Count = residents.filter(r => r.employmentStatus === "Dependent" ).length;
            const emp6Count = residents.filter(r => r.employmentStatus === "Pensioner" ).length;
            const emp7Count = residents.filter(r => r.employmentStatus === "Retired" ).length;

            const indigentCount = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Indigent",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            const nonIndigent = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Non-Indigent",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            const npoorCount = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Low Income",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            // PWD, Solo Parent, and Senior Citizen Percentages
            
            const pwdPercentage = totalPopulation ? formatPercentage(((pwdCount / totalPopulation) * 100).toFixed(2)) : "0";
            const soloParentPercentage = totalPopulation ? formatPercentage(((soloParentCount / totalPopulation) * 100).toFixed(2)) : "0";
            const seniorCitizenPercentage = totalPopulation ? formatPercentage(((seniorCitizenCount / totalPopulation) * 100).toFixed(2)) : "0";
            const pregPercentage = totalPopulation ? formatPercentage(((pregCount / totalPopulation) * 100).toFixed(2)) : "0";
            const indigentPercentage = totalFamilies ? formatPercentage(((indigentCount / totalFamilies) * 100).toFixed(2)) : "0";
            const nonIndigentPercentage = totalFamilies ? formatPercentage(((nonIndigent / totalFamilies) * 100).toFixed(2)) : "0";
            const npoorPercentage = totalFamilies ? formatPercentage(((npoorCount / totalFamilies) * 100).toFixed(2)) : "0";
            const empPercentage = totalPopulation ? formatPercentage(((empCount / totalPopulation) * 100).toFixed(2)) : "0";
            const emp2Percentage = totalPopulation ? formatPercentage(((emp2Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp3Percentage = totalPopulation ? formatPercentage(((emp3Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp4Percentage = totalPopulation ? formatPercentage(((emp4Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp5Percentage = totalPopulation ? formatPercentage(((emp5Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp6Percentage = totalPopulation ? formatPercentage(((emp6Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp7Percentage = totalPopulation ? formatPercentage(((emp7Count / totalPopulation) * 100).toFixed(2)) : "0";
            



            // Priority Groups Percentages
            const priorityGroupPercentages = {};
            Object.keys(priorityGroups).forEach(key => {
                priorityGroupPercentages[key] = totalPopulation ? ((priorityGroups[key] / totalPopulation) * 100).toFixed(2) : "0";
            });

            // Function to calculate age from birthdate (Handles Month Names)
            function calculateAge(bMonth, bDay, bYear) {
                if (!bMonth || !bDay || !bYear) return 0;

                // Convert month name to number if needed
                const monthNumber = isNaN(bMonth) ? moment().month(bMonth).format("M") : bMonth;
                return moment().diff(`${bYear}-${monthNumber}-${bDay}`, 'years');
            }


            // Age Distribution
            const ageGroups = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5).length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5).length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5).length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12).length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17).length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59).length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length,
            };

            const ageGroups2 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Male").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Male").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Male").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Male").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Male").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Male").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Male").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Male").length,
            };

            const ageGroups3 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Female").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Female").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Female").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Female").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Female").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Female").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Female").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Female").length,
            };

            // Age Group Percentages
            const ageGroupPercentages = {};
            Object.keys(ageGroups).forEach(key => {
                ageGroupPercentages[key] = totalPopulation ? formatPercentage(((ageGroups[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages2 = {};
            Object.keys(ageGroups2).forEach(key => {
                ageGroupPercentages2[key] = totalPopulation ? formatPercentage(((ageGroups2[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages3 = {};
            Object.keys(ageGroups3).forEach(key => {
                ageGroupPercentages3[key] = totalPopulation ? formatPercentage(((ageGroups3[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

      
            const ageGroups4 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pwd === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pwd === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pwd === "on").length,
            };
            
            
            const ageGroups5 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pregnant === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pregnant === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pregnant === "on").length,
            };

                        
            const ageGroups6 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.soloParent === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.soloParent === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.soloParent === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.soloParent === "on").length,
            };


                        
// Age Group 7 (for reference - note correction for "Senior" as it had `r.pwd === "Employed").employmentStatus` which seems incorrect for counting employed seniors)
const ageGroups7 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Employed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Employed").length, // Corrected assumption: count of employed seniors
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Employed").length,
};

// --- New Age Group Objects ---

// Age Group 8: Unemployed
const ageGroups8 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Unemployed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Unemployed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Unemployed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Unemployed").length,
};


// Age Group 9: Self-Employed
const ageGroups9 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Self-Employed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Self-Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Self-Employed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Self-Employed").length,
};


// Age Group 10: Student
const ageGroups10 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Student").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Student").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Student").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Student").length,
};

// Age Group 11: Dependent
const ageGroups11 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Dependent").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Dependent").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Dependent").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Dependent").length,
};

// Age Group 12: Retired
const ageGroups12 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Retired").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Retired").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Retired").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Retired").length,
};

// Age Group 13: Pensioner
const ageGroups13 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Pensioner").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Pensioner").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Pensioner").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Pensioner").length,
};

// Age Group 4
const ageGroupPercentages4 = {};
Object.keys(ageGroups4).forEach(key => {
    ageGroupPercentages4[key] = totalPopulation ? formatPercentage(((ageGroups4[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 5
const ageGroupPercentages5 = {};
Object.keys(ageGroups5).forEach(key => {
    ageGroupPercentages5[key] = totalPopulation ? formatPercentage(((ageGroups5[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 6
const ageGroupPercentages6 = {};
Object.keys(ageGroups6).forEach(key => {
    ageGroupPercentages6[key] = totalPopulation ? formatPercentage(((ageGroups6[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 7
const ageGroupPercentages7 = {};
Object.keys(ageGroups7).forEach(key => {
    ageGroupPercentages7[key] = totalPopulation ? formatPercentage(((ageGroups7[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 8
const ageGroupPercentages8 = {};
Object.keys(ageGroups8).forEach(key => {
    ageGroupPercentages8[key] = totalPopulation ? formatPercentage(((ageGroups8[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 9
const ageGroupPercentages9 = {};
Object.keys(ageGroups9).forEach(key => {
    ageGroupPercentages9[key] = totalPopulation ? formatPercentage(((ageGroups9[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 10
const ageGroupPercentages10 = {};
Object.keys(ageGroups10).forEach(key => {
    ageGroupPercentages10[key] = totalPopulation ? formatPercentage(((ageGroups10[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 11
const ageGroupPercentages11 = {};
Object.keys(ageGroups11).forEach(key => {
    ageGroupPercentages11[key] = totalPopulation ? formatPercentage(((ageGroups11[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 12
const ageGroupPercentages12 = {};
Object.keys(ageGroups12).forEach(key => {
    ageGroupPercentages12[key] = totalPopulation ? formatPercentage(((ageGroups12[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 13
const ageGroupPercentages13 = {};
Object.keys(ageGroups13).forEach(key => {
    ageGroupPercentages13[key] = totalPopulation ? formatPercentage(((ageGroups13[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

            // Total Households (Unique Addresses: houseNo + purok)
            const uniqueHouseholds = await db.collection("household").countDocuments({ archive: { $in: ["0", 0] }, purok: "Dike" });


            // SK Voters (15-30 years old with precinct)
            const skVoters = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length;

            // Registered Voters (Residents with a precinct value)
            const registeredVoters = residents.filter(r => r.precinct === "Registered Voter").length;
            const titlePage = "Purok Dike";
            
// 👇 INSERT FAMILY SIZE + POVERTY BREAKDOWN HERE

const familySizes = await db.collection("resident").aggregate([
    { $match: { 
        archive: { $in: ["0", 0] },
        householdId: { $in: dikeStreetHouseholdIds }
    }},
    { $group: { _id: "$familyId", size: { $sum: 1 } } }
]).toArray();

// Step 2: Map family sizes into ranges
function getFamilySizeRange(size) {
  if (size <= 2) return "1-2";
  if (size <= 4) return "3-4";
  if (size <= 6) return "5-6";
  if (size <= 8) return "7-8";
  return "9 & above";
}

// Poverty result container
const povertyCounts = {
  "1-2": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "3-4": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "5-6": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "7-8": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "9 & above": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 }
};

function getFamilySizeRange(size) {
  if (size <= 2) return "1-2";
  if (size <= 4) return "3-4";
  if (size <= 6) return "5-6";
  if (size <= 8) return "7-8";
  return "9 & above";
}

// Variables for averages and extremes
let totalFamSize = 0, totalIncome = 0, count = 0;
let highFam = 0, highIncome = 0;
let lowFam = null, lowIncome = null;

familyData.forEach(fam => {
  const famSize = fam.famSize || 0;
  const currentIncome = fam.famIncome || 0;

  // Poverty breakdown
  const range = getFamilySizeRange(famSize);
  if (povertyCounts[range] && povertyCounts[range][fam.poverty] !== undefined) {
    povertyCounts[range][fam.poverty] += 1;
  }

  // Totals for averages
  totalFamSize += famSize;
  totalIncome += currentIncome;
  count++;

  // Highest
  if (famSize > highFam) highFam = famSize;
  if (currentIncome > highIncome) highIncome = currentIncome;

  // Lowest (excluding 0)
  if (famSize > 0 && (lowFam === null || famSize < lowFam)) lowFam = famSize;
  if (currentIncome > 0 && (lowIncome === null || currentIncome < lowIncome)) lowIncome = currentIncome;
});

// Adjust lowest values
lowFam = (lowFam === null) ? 0 : lowFam;
lowIncome = (lowIncome === null) ? 0 : lowIncome;

// Final computed values
const aveFam = count > 0 ? (totalFamSize / count).toFixed(2) : 0;
const aveIncome = count > 0 ? (totalIncome / count).toFixed(2) : 0;


  const lat = 15.4869;   // Cabanatuan latitude
  const lon = 120.9730;  // Cabanatuan longitude
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;

console.log("✅ Family Aggregation Complete");
            // Render to EJS
            res.render("dsb", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb",
                weatherCode: weather.current_weather.weathercode,
                pendingCount,
                totalPopulation,
                uniqueHouseholds,
                totalFamilies,
                skVoters,
                registeredVoters,
                businesses,
                maleCount, malePercentage,
                femaleCount, femalePercentage,
                priorityGroups, priorityGroupPercentages, ageGroups, ageGroupPercentages, ageGroups2, ageGroupPercentages2, ageGroups3, ageGroupPercentages3, ageGroups4, ageGroupPercentages4, ageGroups5, ageGroupPercentages5, ageGroups6, ageGroupPercentages6, ageGroups7, ageGroupPercentages7, ageGroups8, ageGroupPercentages8, ageGroups9, ageGroupPercentages9, ageGroups10, ageGroupPercentages10, ageGroups11, ageGroupPercentages11, ageGroups12, ageGroupPercentages12, ageGroups13, ageGroupPercentages13,
                pwdCount, soloParentCount, seniorCitizenCount,indigentCount, nonIndigent, npoorCount, empCount, emp2Count, pregCount,
                 emp3Count, emp4Count, emp5Count, emp6Count, emp7Count,
                pwdPercentage, soloParentPercentage, seniorCitizenPercentage, indigentPercentage, nonIndigentPercentage, npoorPercentage, empPercentage, emp3Percentage, emp4Percentage, emp5Percentage, emp6Percentage, emp7Percentage,
                emp2Percentage, pregPercentage, titlePage,  
  povertyCounts,
  aveFam,
  aveIncome,
  highFam,
  highIncome, lowIncome
            });

        } catch (err) {
            console.error("❌ Error fetching dashboard data:", err);
            res.render("dsbDike", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb2",
                pendingCount: 0,
                totalPopulation: 0,
                uniqueHouseholds: 0,
                totalFamilies: 0,
                skVoters: 0,
                registeredVoters: 0,
                businesses: 0,
                maleCount: 0,
                malePercentage: "0",
                femaleCount: 0,
                femalePercentage: "0",
                priorityGroups: {},
                priorityGroupPercentages: {},
                ageGroups: {},
                ageGroupPercentages: {},
                pwdCount: 0,
                soloParentCount: 0,
                seniorCitizenCount: 0, titlePage,  
  povertyCounts,
  aveFam,
  aveIncome,
  highFam,
  highIncome, lowIncome
            });
        }
    });

        
app.get("/dsbShortcut", isLogin, sumDoc, sumReq, async (req, res) => {
        
        try {
            const dikeStreetHouseholds = await db.collection("household").find(
                { purok: "Shortcut" }, // Filter households by their 'purok' field
                { _id: 1 } // Only retrieve the '_id' field for these households (makes it efficient)
            ).toArray();
            // ✅ Step 2: families with residents included
const familyData = await db.collection("family").aggregate([
  {
    $lookup: {
      from: "household",
      let: { hhId: "$householdId" },
      pipeline: [
        { $match: { $expr: { $eq: ["$_id", { $toObjectId: "$$hhId" }] } } }
      ],
      as: "household"
    }
  },
  { $unwind: "$household" },
  { $match: { "household.purok": "Shortcut", archive: { $in: ["0", 0] } } },
  {
    $lookup: {
      from: "resident",
      localField: "_id",
      foreignField: "familyId",
      as: "residents"
    }
  },
  {
    $addFields: {
      famSize: { $size: "$residents" },
      famIncome: { $toInt: "$familyIncome" },
      poverty: "$poverty"
    }
  }
]).toArray();

        // 2. Extract just the '_id' values into an array
            const dikeStreetHouseholdIds = dikeStreetHouseholds.map(h => h._id);

        // --- MODIFY THIS LINE (just adding one condition): ---
        // Now, fetch residents who are active (archive: 0 or "0")
        // AND whose 'householdId' is found in our 'dikeStreetHouseholdIds' array.
            const residents = await db.collection("resident").find({
                archive: { $in: ["0", 0] }, // Your existing filter for active residents
                householdId: { $in: dikeStreetHouseholdIds } // NEW: Filter by associated Dike Street households
            }).toArray();

            const businesses = await db.collection("business").countDocuments({ archive: { $in: ["0", 0] }, purok: "Shortcut" });
            const pendingCount = await db.collection("request").countDocuments({ 
                status: { $in: ["Pending", "Processing"] } 
            });
            

            // Total Population
            const totalPopulation = residents.length;

            const householdIdStrings = dikeStreetHouseholds.map(h => h._id.toString());

            const totalFamilies = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            $expr: { 
                $in: [{ $toString: "$householdId" }, householdIdStrings] 
            }
            });
            
            function formatPercentage(value) {
                return value.endsWith(".00") ? parseInt(value) : value;
            }

            // Gender Distribution
            const maleCount = residents.filter(r => r.gender?.toLowerCase() === "male").length;
            const femaleCount = residents.filter(r => r.gender?.toLowerCase() === "female").length;
            const malePercentage = totalPopulation ? formatPercentage(((maleCount / totalPopulation) * 100).toFixed(2)) : "0";
            const femalePercentage = totalPopulation ? formatPercentage(((femaleCount / totalPopulation) * 100).toFixed(2)) : "0";

            // Priority Groups
            const priorityGroups = {
                "Senior Citizen": residents.filter(r => r.priority === "Senior Citizen").length,
                "PWD": residents.filter(r => r.pwd === "on").length,
                "Solo Parent": residents.filter(r => r.soloParent === "on").length,
            };

            // Additional Counts
            const pwdCount = residents.filter(r => r.pwd === "on").length;
            const soloParentCount = residents.filter(r => r.soloParent === "on").length;
            const seniorCitizenCount = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length;
            const pregCount = residents.filter(r => r.pregnant === "on").length;
            const empCount = residents.filter(r => r.employmentStatus === "Employed" ).length;
            const emp2Count = residents.filter(r => r.employmentStatus === "Unemployed" ).length;
            const emp3Count = residents.filter(r => r.employmentStatus === "Self-Employed" ).length;
            const emp4Count = residents.filter(r => r.employmentStatus === "Student" ).length;
            const emp5Count = residents.filter(r => r.employmentStatus === "Dependent" ).length;
            const emp6Count = residents.filter(r => r.employmentStatus === "Pensioner" ).length;
            const emp7Count = residents.filter(r => r.employmentStatus === "Retired" ).length;

            const indigentCount = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Indigent",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            const nonIndigent = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Non-Indigent",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            const npoorCount = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Low Income",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            // PWD, Solo Parent, and Senior Citizen Percentages
            
            const pwdPercentage = totalPopulation ? formatPercentage(((pwdCount / totalPopulation) * 100).toFixed(2)) : "0";
            const soloParentPercentage = totalPopulation ? formatPercentage(((soloParentCount / totalPopulation) * 100).toFixed(2)) : "0";
            const seniorCitizenPercentage = totalPopulation ? formatPercentage(((seniorCitizenCount / totalPopulation) * 100).toFixed(2)) : "0";
            const pregPercentage = totalPopulation ? formatPercentage(((pregCount / totalPopulation) * 100).toFixed(2)) : "0";
            const indigentPercentage = totalFamilies ? formatPercentage(((indigentCount / totalFamilies) * 100).toFixed(2)) : "0";
            const nonIndigentPercentage = totalFamilies ? formatPercentage(((nonIndigent / totalFamilies) * 100).toFixed(2)) : "0";
            const npoorPercentage = totalFamilies ? formatPercentage(((npoorCount / totalFamilies) * 100).toFixed(2)) : "0";
            const empPercentage = totalPopulation ? formatPercentage(((empCount / totalPopulation) * 100).toFixed(2)) : "0";
            const emp2Percentage = totalPopulation ? formatPercentage(((emp2Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp3Percentage = totalPopulation ? formatPercentage(((emp3Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp4Percentage = totalPopulation ? formatPercentage(((emp4Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp5Percentage = totalPopulation ? formatPercentage(((emp5Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp6Percentage = totalPopulation ? formatPercentage(((emp6Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp7Percentage = totalPopulation ? formatPercentage(((emp7Count / totalPopulation) * 100).toFixed(2)) : "0";
            



            // Priority Groups Percentages
            const priorityGroupPercentages = {};
            Object.keys(priorityGroups).forEach(key => {
                priorityGroupPercentages[key] = totalPopulation ? ((priorityGroups[key] / totalPopulation) * 100).toFixed(2) : "0";
            });

            // Function to calculate age from birthdate (Handles Month Names)
            function calculateAge(bMonth, bDay, bYear) {
                if (!bMonth || !bDay || !bYear) return 0;

                // Convert month name to number if needed
                const monthNumber = isNaN(bMonth) ? moment().month(bMonth).format("M") : bMonth;
                return moment().diff(`${bYear}-${monthNumber}-${bDay}`, 'years');
            }


            // Age Distribution
            const ageGroups = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5).length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5).length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5).length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12).length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17).length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59).length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length,
            };

            const ageGroups2 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Male").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Male").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Male").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Male").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Male").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Male").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Male").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Male").length,
            };

            const ageGroups3 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Female").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Female").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Female").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Female").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Female").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Female").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Female").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Female").length,
            };

            // Age Group Percentages
            const ageGroupPercentages = {};
            Object.keys(ageGroups).forEach(key => {
                ageGroupPercentages[key] = totalPopulation ? formatPercentage(((ageGroups[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages2 = {};
            Object.keys(ageGroups2).forEach(key => {
                ageGroupPercentages2[key] = totalPopulation ? formatPercentage(((ageGroups2[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages3 = {};
            Object.keys(ageGroups3).forEach(key => {
                ageGroupPercentages3[key] = totalPopulation ? formatPercentage(((ageGroups3[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

      
            const ageGroups4 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pwd === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pwd === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pwd === "on").length,
            };
            
            
            const ageGroups5 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pregnant === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pregnant === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pregnant === "on").length,
            };

                        
            const ageGroups6 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.soloParent === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.soloParent === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.soloParent === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.soloParent === "on").length,
            };


                        
// Age Group 7 (for reference - note correction for "Senior" as it had `r.pwd === "Employed").employmentStatus` which seems incorrect for counting employed seniors)
const ageGroups7 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Employed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Employed").length, // Corrected assumption: count of employed seniors
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Employed").length,
};

// --- New Age Group Objects ---

// Age Group 8: Unemployed
const ageGroups8 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Unemployed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Unemployed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Unemployed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Unemployed").length,
};


// Age Group 9: Self-Employed
const ageGroups9 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Self-Employed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Self-Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Self-Employed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Self-Employed").length,
};


// Age Group 10: Student
const ageGroups10 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Student").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Student").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Student").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Student").length,
};

// Age Group 11: Dependent
const ageGroups11 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Dependent").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Dependent").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Dependent").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Dependent").length,
};

// Age Group 12: Retired
const ageGroups12 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Retired").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Retired").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Retired").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Retired").length,
};

// Age Group 13: Pensioner
const ageGroups13 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Pensioner").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Pensioner").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Pensioner").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Pensioner").length,
};

// Age Group 4
const ageGroupPercentages4 = {};
Object.keys(ageGroups4).forEach(key => {
    ageGroupPercentages4[key] = totalPopulation ? formatPercentage(((ageGroups4[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 5
const ageGroupPercentages5 = {};
Object.keys(ageGroups5).forEach(key => {
    ageGroupPercentages5[key] = totalPopulation ? formatPercentage(((ageGroups5[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 6
const ageGroupPercentages6 = {};
Object.keys(ageGroups6).forEach(key => {
    ageGroupPercentages6[key] = totalPopulation ? formatPercentage(((ageGroups6[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 7
const ageGroupPercentages7 = {};
Object.keys(ageGroups7).forEach(key => {
    ageGroupPercentages7[key] = totalPopulation ? formatPercentage(((ageGroups7[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 8
const ageGroupPercentages8 = {};
Object.keys(ageGroups8).forEach(key => {
    ageGroupPercentages8[key] = totalPopulation ? formatPercentage(((ageGroups8[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 9
const ageGroupPercentages9 = {};
Object.keys(ageGroups9).forEach(key => {
    ageGroupPercentages9[key] = totalPopulation ? formatPercentage(((ageGroups9[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 10
const ageGroupPercentages10 = {};
Object.keys(ageGroups10).forEach(key => {
    ageGroupPercentages10[key] = totalPopulation ? formatPercentage(((ageGroups10[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 11
const ageGroupPercentages11 = {};
Object.keys(ageGroups11).forEach(key => {
    ageGroupPercentages11[key] = totalPopulation ? formatPercentage(((ageGroups11[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 12
const ageGroupPercentages12 = {};
Object.keys(ageGroups12).forEach(key => {
    ageGroupPercentages12[key] = totalPopulation ? formatPercentage(((ageGroups12[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 13
const ageGroupPercentages13 = {};
Object.keys(ageGroups13).forEach(key => {
    ageGroupPercentages13[key] = totalPopulation ? formatPercentage(((ageGroups13[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

            // Total Households (Unique Addresses: houseNo + purok)
            const uniqueHouseholds = await db.collection("household").countDocuments({ archive: { $in: ["0", 0] }, purok: "Shortcut" });


            // SK Voters (15-30 years old with precinct)
            const skVoters = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length;

            // Registered Voters (Residents with a precinct value)
            const registeredVoters = residents.filter(r => r.precinct === "Registered Voter").length;
            const titlePage = "Purok Shortcut";
            
// 👇 INSERT FAMILY SIZE + POVERTY BREAKDOWN HERE

const familySizes = await db.collection("resident").aggregate([
    { $match: { 
        archive: { $in: ["0", 0] },
        householdId: { $in: dikeStreetHouseholdIds }
    }},
    { $group: { _id: "$familyId", size: { $sum: 1 } } }
]).toArray();

// Step 2: Map family sizes into ranges
function getFamilySizeRange(size) {
  if (size <= 2) return "1-2";
  if (size <= 4) return "3-4";
  if (size <= 6) return "5-6";
  if (size <= 8) return "7-8";
  return "9 & above";
}

// Poverty result container
const povertyCounts = {
  "1-2": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "3-4": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "5-6": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "7-8": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "9 & above": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 }
};

function getFamilySizeRange(size) {
  if (size <= 2) return "1-2";
  if (size <= 4) return "3-4";
  if (size <= 6) return "5-6";
  if (size <= 8) return "7-8";
  return "9 & above";
}

// Variables for averages and extremes
let totalFamSize = 0, totalIncome = 0, count = 0;
let highFam = 0, highIncome = 0;
let lowFam = null, lowIncome = null;

familyData.forEach(fam => {
  const famSize = fam.famSize || 0;
  const currentIncome = fam.famIncome || 0;

  // Poverty breakdown
  const range = getFamilySizeRange(famSize);
  if (povertyCounts[range] && povertyCounts[range][fam.poverty] !== undefined) {
    povertyCounts[range][fam.poverty] += 1;
  }

  // Totals for averages
  totalFamSize += famSize;
  totalIncome += currentIncome;
  count++;

  // Highest
  if (famSize > highFam) highFam = famSize;
  if (currentIncome > highIncome) highIncome = currentIncome;

  // Lowest (excluding 0)
  if (famSize > 0 && (lowFam === null || famSize < lowFam)) lowFam = famSize;
  if (currentIncome > 0 && (lowIncome === null || currentIncome < lowIncome)) lowIncome = currentIncome;
});

// Adjust lowest values
lowFam = (lowFam === null) ? 0 : lowFam;
lowIncome = (lowIncome === null) ? 0 : lowIncome;

// Final computed values
const aveFam = count > 0 ? (totalFamSize / count).toFixed(2) : 0;
const aveIncome = count > 0 ? (totalIncome / count).toFixed(2) : 0;


  const lat = 15.4869;   // Cabanatuan latitude
  const lon = 120.9730;  // Cabanatuan longitude
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;

console.log("✅ Family Aggregation Complete");
            // Render to EJS
            res.render("dsb", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb",
                weatherCode: weather.current_weather.weathercode,
                pendingCount,
                totalPopulation,
                uniqueHouseholds,
                totalFamilies,
                skVoters,
                registeredVoters,
                businesses,
                maleCount, malePercentage,
                femaleCount, femalePercentage,
                priorityGroups, priorityGroupPercentages, ageGroups, ageGroupPercentages, ageGroups2, ageGroupPercentages2, ageGroups3, ageGroupPercentages3, ageGroups4, ageGroupPercentages4, ageGroups5, ageGroupPercentages5, ageGroups6, ageGroupPercentages6, ageGroups7, ageGroupPercentages7, ageGroups8, ageGroupPercentages8, ageGroups9, ageGroupPercentages9, ageGroups10, ageGroupPercentages10, ageGroups11, ageGroupPercentages11, ageGroups12, ageGroupPercentages12, ageGroups13, ageGroupPercentages13,
                pwdCount, soloParentCount, seniorCitizenCount,indigentCount, nonIndigent, npoorCount, empCount, emp2Count, pregCount,
                 emp3Count, emp4Count, emp5Count, emp6Count, emp7Count,
                pwdPercentage, soloParentPercentage, seniorCitizenPercentage, indigentPercentage, nonIndigentPercentage, npoorPercentage, empPercentage, emp3Percentage, emp4Percentage, emp5Percentage, emp6Percentage, emp7Percentage,
                emp2Percentage, pregPercentage, titlePage,  
  povertyCounts,
  aveFam,
  aveIncome,
  highFam,
  highIncome, lowIncome
            });

        } catch (err) {
            console.error("❌ Error fetching dashboard data:", err);
            res.render("index", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb2",
                error: "Something went wrong!",
            });
        }
    });
 
        
app.get("/dsbCantarilla", isLogin, sumDoc, sumReq, async (req, res) => {
        
        try {
            const dikeStreetHouseholds = await db.collection("household").find(
                { purok: "Cantarilla" }, // Filter households by their 'purok' field
                { _id: 1 } // Only retrieve the '_id' field for these households (makes it efficient)
            ).toArray();
            // ✅ Step 2: families with residents included
const familyData = await db.collection("family").aggregate([
  {
    $lookup: {
      from: "household",
      let: { hhId: "$householdId" },
      pipeline: [
        { $match: { $expr: { $eq: ["$_id", { $toObjectId: "$$hhId" }] } } }
      ],
      as: "household"
    }
  },
  { $unwind: "$household" },
  { $match: { "household.purok": "Cantarilla", archive: { $in: ["0", 0] } } },
  {
    $lookup: {
      from: "resident",
      localField: "_id",
      foreignField: "familyId",
      as: "residents"
    }
  },
  {
    $addFields: {
      famSize: { $size: "$residents" },
      famIncome: { $toInt: "$familyIncome" },
      poverty: "$poverty"
    }
  }
]).toArray();

        // 2. Extract just the '_id' values into an array
            const dikeStreetHouseholdIds = dikeStreetHouseholds.map(h => h._id);

        // --- MODIFY THIS LINE (just adding one condition): ---
        // Now, fetch residents who are active (archive: 0 or "0")
        // AND whose 'householdId' is found in our 'dikeStreetHouseholdIds' array.
            const residents = await db.collection("resident").find({
                archive: { $in: ["0", 0] }, // Your existing filter for active residents
                householdId: { $in: dikeStreetHouseholdIds } // NEW: Filter by associated Dike Street households
            }).toArray();

            const businesses = await db.collection("business").countDocuments({ archive: { $in: ["0", 0] }, purok: "Cantarilla" });
            const pendingCount = await db.collection("request").countDocuments({ 
                status: { $in: ["Pending", "Processing"] } 
            });
            

            // Total Population
            const totalPopulation = residents.length;

            const householdIdStrings = dikeStreetHouseholds.map(h => h._id.toString());

            const totalFamilies = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            $expr: { 
                $in: [{ $toString: "$householdId" }, householdIdStrings] 
            }
            });
            
            function formatPercentage(value) {
                return value.endsWith(".00") ? parseInt(value) : value;
            }

            // Gender Distribution
            const maleCount = residents.filter(r => r.gender?.toLowerCase() === "male").length;
            const femaleCount = residents.filter(r => r.gender?.toLowerCase() === "female").length;
            const malePercentage = totalPopulation ? formatPercentage(((maleCount / totalPopulation) * 100).toFixed(2)) : "0";
            const femalePercentage = totalPopulation ? formatPercentage(((femaleCount / totalPopulation) * 100).toFixed(2)) : "0";

            // Priority Groups
            const priorityGroups = {
                "Senior Citizen": residents.filter(r => r.priority === "Senior Citizen").length,
                "PWD": residents.filter(r => r.pwd === "on").length,
                "Solo Parent": residents.filter(r => r.soloParent === "on").length,
            };

            // Additional Counts
            const pwdCount = residents.filter(r => r.pwd === "on").length;
            const soloParentCount = residents.filter(r => r.soloParent === "on").length;
            const seniorCitizenCount = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length;
            const pregCount = residents.filter(r => r.pregnant === "on").length;
            const empCount = residents.filter(r => r.employmentStatus === "Employed" ).length;
            const emp2Count = residents.filter(r => r.employmentStatus === "Unemployed" ).length;
            const emp3Count = residents.filter(r => r.employmentStatus === "Self-Employed" ).length;
            const emp4Count = residents.filter(r => r.employmentStatus === "Student" ).length;
            const emp5Count = residents.filter(r => r.employmentStatus === "Dependent" ).length;
            const emp6Count = residents.filter(r => r.employmentStatus === "Pensioner" ).length;
            const emp7Count = residents.filter(r => r.employmentStatus === "Retired" ).length;

            const indigentCount = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Indigent",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            const nonIndigent = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Non-Indigent",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            const npoorCount = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Low Income",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            // PWD, Solo Parent, and Senior Citizen Percentages
            
            const pwdPercentage = totalPopulation ? formatPercentage(((pwdCount / totalPopulation) * 100).toFixed(2)) : "0";
            const soloParentPercentage = totalPopulation ? formatPercentage(((soloParentCount / totalPopulation) * 100).toFixed(2)) : "0";
            const seniorCitizenPercentage = totalPopulation ? formatPercentage(((seniorCitizenCount / totalPopulation) * 100).toFixed(2)) : "0";
            const pregPercentage = totalPopulation ? formatPercentage(((pregCount / totalPopulation) * 100).toFixed(2)) : "0";
            const indigentPercentage = totalFamilies ? formatPercentage(((indigentCount / totalFamilies) * 100).toFixed(2)) : "0";
            const nonIndigentPercentage = totalFamilies ? formatPercentage(((nonIndigent / totalFamilies) * 100).toFixed(2)) : "0";
            const npoorPercentage = totalFamilies ? formatPercentage(((npoorCount / totalFamilies) * 100).toFixed(2)) : "0";
            const empPercentage = totalPopulation ? formatPercentage(((empCount / totalPopulation) * 100).toFixed(2)) : "0";
            const emp2Percentage = totalPopulation ? formatPercentage(((emp2Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp3Percentage = totalPopulation ? formatPercentage(((emp3Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp4Percentage = totalPopulation ? formatPercentage(((emp4Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp5Percentage = totalPopulation ? formatPercentage(((emp5Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp6Percentage = totalPopulation ? formatPercentage(((emp6Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp7Percentage = totalPopulation ? formatPercentage(((emp7Count / totalPopulation) * 100).toFixed(2)) : "0";
            



            // Priority Groups Percentages
            const priorityGroupPercentages = {};
            Object.keys(priorityGroups).forEach(key => {
                priorityGroupPercentages[key] = totalPopulation ? ((priorityGroups[key] / totalPopulation) * 100).toFixed(2) : "0";
            });

            // Function to calculate age from birthdate (Handles Month Names)
            function calculateAge(bMonth, bDay, bYear) {
                if (!bMonth || !bDay || !bYear) return 0;

                // Convert month name to number if needed
                const monthNumber = isNaN(bMonth) ? moment().month(bMonth).format("M") : bMonth;
                return moment().diff(`${bYear}-${monthNumber}-${bDay}`, 'years');
            }


            // Age Distribution
            const ageGroups = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5).length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5).length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5).length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12).length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17).length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59).length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length,
            };

            const ageGroups2 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Male").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Male").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Male").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Male").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Male").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Male").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Male").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Male").length,
            };

            const ageGroups3 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Female").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Female").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Female").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Female").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Female").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Female").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Female").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Female").length,
            };

            // Age Group Percentages
            const ageGroupPercentages = {};
            Object.keys(ageGroups).forEach(key => {
                ageGroupPercentages[key] = totalPopulation ? formatPercentage(((ageGroups[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages2 = {};
            Object.keys(ageGroups2).forEach(key => {
                ageGroupPercentages2[key] = totalPopulation ? formatPercentage(((ageGroups2[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages3 = {};
            Object.keys(ageGroups3).forEach(key => {
                ageGroupPercentages3[key] = totalPopulation ? formatPercentage(((ageGroups3[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

      
            const ageGroups4 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pwd === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pwd === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pwd === "on").length,
            };
            
            
            const ageGroups5 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pregnant === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pregnant === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pregnant === "on").length,
            };

                        
            const ageGroups6 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.soloParent === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.soloParent === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.soloParent === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.soloParent === "on").length,
            };


                        
// Age Group 7 (for reference - note correction for "Senior" as it had `r.pwd === "Employed").employmentStatus` which seems incorrect for counting employed seniors)
const ageGroups7 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Employed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Employed").length, // Corrected assumption: count of employed seniors
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Employed").length,
};

// --- New Age Group Objects ---

// Age Group 8: Unemployed
const ageGroups8 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Unemployed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Unemployed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Unemployed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Unemployed").length,
};


// Age Group 9: Self-Employed
const ageGroups9 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Self-Employed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Self-Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Self-Employed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Self-Employed").length,
};


// Age Group 10: Student
const ageGroups10 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Student").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Student").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Student").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Student").length,
};

// Age Group 11: Dependent
const ageGroups11 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Dependent").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Dependent").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Dependent").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Dependent").length,
};

// Age Group 12: Retired
const ageGroups12 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Retired").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Retired").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Retired").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Retired").length,
};

// Age Group 13: Pensioner
const ageGroups13 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Pensioner").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Pensioner").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Pensioner").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Pensioner").length,
};

// Age Group 4
const ageGroupPercentages4 = {};
Object.keys(ageGroups4).forEach(key => {
    ageGroupPercentages4[key] = totalPopulation ? formatPercentage(((ageGroups4[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 5
const ageGroupPercentages5 = {};
Object.keys(ageGroups5).forEach(key => {
    ageGroupPercentages5[key] = totalPopulation ? formatPercentage(((ageGroups5[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 6
const ageGroupPercentages6 = {};
Object.keys(ageGroups6).forEach(key => {
    ageGroupPercentages6[key] = totalPopulation ? formatPercentage(((ageGroups6[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 7
const ageGroupPercentages7 = {};
Object.keys(ageGroups7).forEach(key => {
    ageGroupPercentages7[key] = totalPopulation ? formatPercentage(((ageGroups7[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 8
const ageGroupPercentages8 = {};
Object.keys(ageGroups8).forEach(key => {
    ageGroupPercentages8[key] = totalPopulation ? formatPercentage(((ageGroups8[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 9
const ageGroupPercentages9 = {};
Object.keys(ageGroups9).forEach(key => {
    ageGroupPercentages9[key] = totalPopulation ? formatPercentage(((ageGroups9[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 10
const ageGroupPercentages10 = {};
Object.keys(ageGroups10).forEach(key => {
    ageGroupPercentages10[key] = totalPopulation ? formatPercentage(((ageGroups10[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 11
const ageGroupPercentages11 = {};
Object.keys(ageGroups11).forEach(key => {
    ageGroupPercentages11[key] = totalPopulation ? formatPercentage(((ageGroups11[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 12
const ageGroupPercentages12 = {};
Object.keys(ageGroups12).forEach(key => {
    ageGroupPercentages12[key] = totalPopulation ? formatPercentage(((ageGroups12[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 13
const ageGroupPercentages13 = {};
Object.keys(ageGroups13).forEach(key => {
    ageGroupPercentages13[key] = totalPopulation ? formatPercentage(((ageGroups13[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

            // Total Households (Unique Addresses: houseNo + purok)
            const uniqueHouseholds = await db.collection("household").countDocuments({ archive: { $in: ["0", 0] }, purok: "Cantarilla" });


            // SK Voters (15-30 years old with precinct)
            const skVoters = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length;

            // Registered Voters (Residents with a precinct value)
            const registeredVoters = residents.filter(r => r.precinct === "Registered Voter").length;
            const titlePage = "Purok Cantarilla";
            
// 👇 INSERT FAMILY SIZE + POVERTY BREAKDOWN HERE

const familySizes = await db.collection("resident").aggregate([
    { $match: { 
        archive: { $in: ["0", 0] },
        householdId: { $in: dikeStreetHouseholdIds }
    }},
    { $group: { _id: "$familyId", size: { $sum: 1 } } }
]).toArray();

// Step 2: Map family sizes into ranges
function getFamilySizeRange(size) {
  if (size <= 2) return "1-2";
  if (size <= 4) return "3-4";
  if (size <= 6) return "5-6";
  if (size <= 8) return "7-8";
  return "9 & above";
}

// Poverty result container
const povertyCounts = {
  "1-2": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "3-4": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "5-6": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "7-8": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "9 & above": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 }
};

function getFamilySizeRange(size) {
  if (size <= 2) return "1-2";
  if (size <= 4) return "3-4";
  if (size <= 6) return "5-6";
  if (size <= 8) return "7-8";
  return "9 & above";
}

// Variables for averages and extremes
let totalFamSize = 0, totalIncome = 0, count = 0;
let highFam = 0, highIncome = 0;
let lowFam = null, lowIncome = null;

familyData.forEach(fam => {
  const famSize = fam.famSize || 0;
  const currentIncome = fam.famIncome || 0;

  // Poverty breakdown
  const range = getFamilySizeRange(famSize);
  if (povertyCounts[range] && povertyCounts[range][fam.poverty] !== undefined) {
    povertyCounts[range][fam.poverty] += 1;
  }

  // Totals for averages
  totalFamSize += famSize;
  totalIncome += currentIncome;
  count++;

  // Highest
  if (famSize > highFam) highFam = famSize;
  if (currentIncome > highIncome) highIncome = currentIncome;

  // Lowest (excluding 0)
  if (famSize > 0 && (lowFam === null || famSize < lowFam)) lowFam = famSize;
  if (currentIncome > 0 && (lowIncome === null || currentIncome < lowIncome)) lowIncome = currentIncome;
});

// Adjust lowest values
lowFam = (lowFam === null) ? 0 : lowFam;
lowIncome = (lowIncome === null) ? 0 : lowIncome;

// Final computed values
const aveFam = count > 0 ? (totalFamSize / count).toFixed(2) : 0;
const aveIncome = count > 0 ? (totalIncome / count).toFixed(2) : 0;


  const lat = 15.4869;   // Cabanatuan latitude
  const lon = 120.9730;  // Cabanatuan longitude
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;

console.log("✅ Family Aggregation Complete");
            // Render to EJS
            res.render("dsb", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb",
                weatherCode: weather.current_weather.weathercode,
                pendingCount,
                totalPopulation,
                uniqueHouseholds,
                totalFamilies,
                skVoters,
                registeredVoters,
                businesses,
                maleCount, malePercentage,
                femaleCount, femalePercentage,
                priorityGroups, priorityGroupPercentages, ageGroups, ageGroupPercentages, ageGroups2, ageGroupPercentages2, ageGroups3, ageGroupPercentages3, ageGroups4, ageGroupPercentages4, ageGroups5, ageGroupPercentages5, ageGroups6, ageGroupPercentages6, ageGroups7, ageGroupPercentages7, ageGroups8, ageGroupPercentages8, ageGroups9, ageGroupPercentages9, ageGroups10, ageGroupPercentages10, ageGroups11, ageGroupPercentages11, ageGroups12, ageGroupPercentages12, ageGroups13, ageGroupPercentages13,
                pwdCount, soloParentCount, seniorCitizenCount,indigentCount, nonIndigent, npoorCount, empCount, emp2Count, pregCount,
                 emp3Count, emp4Count, emp5Count, emp6Count, emp7Count,
                pwdPercentage, soloParentPercentage, seniorCitizenPercentage, indigentPercentage, nonIndigentPercentage, npoorPercentage, empPercentage, emp3Percentage, emp4Percentage, emp5Percentage, emp6Percentage, emp7Percentage,
                emp2Percentage, pregPercentage, titlePage,  
  povertyCounts,
  aveFam,
  aveIncome,
  highFam,
  highIncome, lowIncome
            });

        } catch (err) {
            console.error("❌ Error fetching dashboard data:", err);
            res.render("index", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb2",
                error: "Something went wrong!",
            });
        }
    });
 
            
app.get("/dsbPerigola", isLogin, sumDoc, sumReq, async (req, res) => {
        
        try {
            const dikeStreetHouseholds = await db.collection("household").find(
                { purok: "Perigola" }, // Filter households by their 'purok' field
                { _id: 1 } // Only retrieve the '_id' field for these households (makes it efficient)
            ).toArray();
            // ✅ Step 2: families with residents included
const familyData = await db.collection("family").aggregate([
  {
    $lookup: {
      from: "household",
      let: { hhId: "$householdId" },
      pipeline: [
        { $match: { $expr: { $eq: ["$_id", { $toObjectId: "$$hhId" }] } } }
      ],
      as: "household"
    }
  },
  { $unwind: "$household" },
  { $match: { "household.purok": "Perigola", archive: { $in: ["0", 0] } } },
  {
    $lookup: {
      from: "resident",
      localField: "_id",
      foreignField: "familyId",
      as: "residents"
    }
  },
  {
    $addFields: {
      famSize: { $size: "$residents" },
      famIncome: { $toInt: "$familyIncome" },
      poverty: "$poverty"
    }
  }
]).toArray();

        // 2. Extract just the '_id' values into an array
            const dikeStreetHouseholdIds = dikeStreetHouseholds.map(h => h._id);

        // --- MODIFY THIS LINE (just adding one condition): ---
        // Now, fetch residents who are active (archive: 0 or "0")
        // AND whose 'householdId' is found in our 'dikeStreetHouseholdIds' array.
            const residents = await db.collection("resident").find({
                archive: { $in: ["0", 0] }, // Your existing filter for active residents
                householdId: { $in: dikeStreetHouseholdIds } // NEW: Filter by associated Dike Street households
            }).toArray();

            const businesses = await db.collection("business").countDocuments({ archive: { $in: ["0", 0] }, purok: "Perigola" });
            const pendingCount = await db.collection("request").countDocuments({ 
                status: { $in: ["Pending", "Processing"] } 
            });
            

            // Total Population
            const totalPopulation = residents.length;

            const householdIdStrings = dikeStreetHouseholds.map(h => h._id.toString());

            const totalFamilies = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            $expr: { 
                $in: [{ $toString: "$householdId" }, householdIdStrings] 
            }
            });
            
            function formatPercentage(value) {
                return value.endsWith(".00") ? parseInt(value) : value;
            }

            // Gender Distribution
            const maleCount = residents.filter(r => r.gender?.toLowerCase() === "male").length;
            const femaleCount = residents.filter(r => r.gender?.toLowerCase() === "female").length;
            const malePercentage = totalPopulation ? formatPercentage(((maleCount / totalPopulation) * 100).toFixed(2)) : "0";
            const femalePercentage = totalPopulation ? formatPercentage(((femaleCount / totalPopulation) * 100).toFixed(2)) : "0";

            // Priority Groups
            const priorityGroups = {
                "Senior Citizen": residents.filter(r => r.priority === "Senior Citizen").length,
                "PWD": residents.filter(r => r.pwd === "on").length,
                "Solo Parent": residents.filter(r => r.soloParent === "on").length,
            };

            // Additional Counts
            const pwdCount = residents.filter(r => r.pwd === "on").length;
            const soloParentCount = residents.filter(r => r.soloParent === "on").length;
            const seniorCitizenCount = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length;
            const pregCount = residents.filter(r => r.pregnant === "on").length;
            const empCount = residents.filter(r => r.employmentStatus === "Employed" ).length;
            const emp2Count = residents.filter(r => r.employmentStatus === "Unemployed" ).length;
            const emp3Count = residents.filter(r => r.employmentStatus === "Self-Employed" ).length;
            const emp4Count = residents.filter(r => r.employmentStatus === "Student" ).length;
            const emp5Count = residents.filter(r => r.employmentStatus === "Dependent" ).length;
            const emp6Count = residents.filter(r => r.employmentStatus === "Pensioner" ).length;
            const emp7Count = residents.filter(r => r.employmentStatus === "Retired" ).length;

            const indigentCount = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Indigent",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            const nonIndigent = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Non-Indigent",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            const npoorCount = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Low Income",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            // PWD, Solo Parent, and Senior Citizen Percentages
            
            const pwdPercentage = totalPopulation ? formatPercentage(((pwdCount / totalPopulation) * 100).toFixed(2)) : "0";
            const soloParentPercentage = totalPopulation ? formatPercentage(((soloParentCount / totalPopulation) * 100).toFixed(2)) : "0";
            const seniorCitizenPercentage = totalPopulation ? formatPercentage(((seniorCitizenCount / totalPopulation) * 100).toFixed(2)) : "0";
            const pregPercentage = totalPopulation ? formatPercentage(((pregCount / totalPopulation) * 100).toFixed(2)) : "0";
            const indigentPercentage = totalFamilies ? formatPercentage(((indigentCount / totalFamilies) * 100).toFixed(2)) : "0";
            const nonIndigentPercentage = totalFamilies ? formatPercentage(((nonIndigent / totalFamilies) * 100).toFixed(2)) : "0";
            const npoorPercentage = totalFamilies ? formatPercentage(((npoorCount / totalFamilies) * 100).toFixed(2)) : "0";
            const empPercentage = totalPopulation ? formatPercentage(((empCount / totalPopulation) * 100).toFixed(2)) : "0";
            const emp2Percentage = totalPopulation ? formatPercentage(((emp2Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp3Percentage = totalPopulation ? formatPercentage(((emp3Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp4Percentage = totalPopulation ? formatPercentage(((emp4Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp5Percentage = totalPopulation ? formatPercentage(((emp5Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp6Percentage = totalPopulation ? formatPercentage(((emp6Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp7Percentage = totalPopulation ? formatPercentage(((emp7Count / totalPopulation) * 100).toFixed(2)) : "0";
            



            // Priority Groups Percentages
            const priorityGroupPercentages = {};
            Object.keys(priorityGroups).forEach(key => {
                priorityGroupPercentages[key] = totalPopulation ? ((priorityGroups[key] / totalPopulation) * 100).toFixed(2) : "0";
            });

            // Function to calculate age from birthdate (Handles Month Names)
            function calculateAge(bMonth, bDay, bYear) {
                if (!bMonth || !bDay || !bYear) return 0;

                // Convert month name to number if needed
                const monthNumber = isNaN(bMonth) ? moment().month(bMonth).format("M") : bMonth;
                return moment().diff(`${bYear}-${monthNumber}-${bDay}`, 'years');
            }


            // Age Distribution
            const ageGroups = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5).length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5).length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5).length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12).length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17).length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59).length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length,
            };

            const ageGroups2 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Male").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Male").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Male").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Male").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Male").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Male").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Male").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Male").length,
            };

            const ageGroups3 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Female").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Female").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Female").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Female").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Female").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Female").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Female").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Female").length,
            };

            // Age Group Percentages
            const ageGroupPercentages = {};
            Object.keys(ageGroups).forEach(key => {
                ageGroupPercentages[key] = totalPopulation ? formatPercentage(((ageGroups[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages2 = {};
            Object.keys(ageGroups2).forEach(key => {
                ageGroupPercentages2[key] = totalPopulation ? formatPercentage(((ageGroups2[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages3 = {};
            Object.keys(ageGroups3).forEach(key => {
                ageGroupPercentages3[key] = totalPopulation ? formatPercentage(((ageGroups3[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

      
            const ageGroups4 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pwd === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pwd === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pwd === "on").length,
            };
            
            
            const ageGroups5 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pregnant === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pregnant === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pregnant === "on").length,
            };

                        
            const ageGroups6 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.soloParent === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.soloParent === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.soloParent === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.soloParent === "on").length,
            };


                        
// Age Group 7 (for reference - note correction for "Senior" as it had `r.pwd === "Employed").employmentStatus` which seems incorrect for counting employed seniors)
const ageGroups7 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Employed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Employed").length, // Corrected assumption: count of employed seniors
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Employed").length,
};

// --- New Age Group Objects ---

// Age Group 8: Unemployed
const ageGroups8 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Unemployed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Unemployed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Unemployed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Unemployed").length,
};


// Age Group 9: Self-Employed
const ageGroups9 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Self-Employed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Self-Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Self-Employed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Self-Employed").length,
};


// Age Group 10: Student
const ageGroups10 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Student").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Student").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Student").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Student").length,
};

// Age Group 11: Dependent
const ageGroups11 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Dependent").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Dependent").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Dependent").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Dependent").length,
};

// Age Group 12: Retired
const ageGroups12 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Retired").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Retired").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Retired").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Retired").length,
};

// Age Group 13: Pensioner
const ageGroups13 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Pensioner").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Pensioner").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Pensioner").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Pensioner").length,
};

// Age Group 4
const ageGroupPercentages4 = {};
Object.keys(ageGroups4).forEach(key => {
    ageGroupPercentages4[key] = totalPopulation ? formatPercentage(((ageGroups4[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 5
const ageGroupPercentages5 = {};
Object.keys(ageGroups5).forEach(key => {
    ageGroupPercentages5[key] = totalPopulation ? formatPercentage(((ageGroups5[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 6
const ageGroupPercentages6 = {};
Object.keys(ageGroups6).forEach(key => {
    ageGroupPercentages6[key] = totalPopulation ? formatPercentage(((ageGroups6[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 7
const ageGroupPercentages7 = {};
Object.keys(ageGroups7).forEach(key => {
    ageGroupPercentages7[key] = totalPopulation ? formatPercentage(((ageGroups7[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 8
const ageGroupPercentages8 = {};
Object.keys(ageGroups8).forEach(key => {
    ageGroupPercentages8[key] = totalPopulation ? formatPercentage(((ageGroups8[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 9
const ageGroupPercentages9 = {};
Object.keys(ageGroups9).forEach(key => {
    ageGroupPercentages9[key] = totalPopulation ? formatPercentage(((ageGroups9[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 10
const ageGroupPercentages10 = {};
Object.keys(ageGroups10).forEach(key => {
    ageGroupPercentages10[key] = totalPopulation ? formatPercentage(((ageGroups10[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 11
const ageGroupPercentages11 = {};
Object.keys(ageGroups11).forEach(key => {
    ageGroupPercentages11[key] = totalPopulation ? formatPercentage(((ageGroups11[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 12
const ageGroupPercentages12 = {};
Object.keys(ageGroups12).forEach(key => {
    ageGroupPercentages12[key] = totalPopulation ? formatPercentage(((ageGroups12[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 13
const ageGroupPercentages13 = {};
Object.keys(ageGroups13).forEach(key => {
    ageGroupPercentages13[key] = totalPopulation ? formatPercentage(((ageGroups13[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

            // Total Households (Unique Addresses: houseNo + purok)
            const uniqueHouseholds = await db.collection("household").countDocuments({ archive: { $in: ["0", 0] }, purok: "Perigola" });


            // SK Voters (15-30 years old with precinct)
            const skVoters = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length;

            // Registered Voters (Residents with a precinct value)
            const registeredVoters = residents.filter(r => r.precinct === "Registered Voter").length;
            const titlePage = "Purok Perigola";
            
// 👇 INSERT FAMILY SIZE + POVERTY BREAKDOWN HERE

const familySizes = await db.collection("resident").aggregate([
    { $match: { 
        archive: { $in: ["0", 0] },
        householdId: { $in: dikeStreetHouseholdIds }
    }},
    { $group: { _id: "$familyId", size: { $sum: 1 } } }
]).toArray();

// Step 2: Map family sizes into ranges
function getFamilySizeRange(size) {
  if (size <= 2) return "1-2";
  if (size <= 4) return "3-4";
  if (size <= 6) return "5-6";
  if (size <= 8) return "7-8";
  return "9 & above";
}

// Poverty result container
const povertyCounts = {
  "1-2": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "3-4": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "5-6": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "7-8": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "9 & above": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 }
};

function getFamilySizeRange(size) {
  if (size <= 2) return "1-2";
  if (size <= 4) return "3-4";
  if (size <= 6) return "5-6";
  if (size <= 8) return "7-8";
  return "9 & above";
}

// Variables for averages and extremes
let totalFamSize = 0, totalIncome = 0, count = 0;
let highFam = 0, highIncome = 0;
let lowFam = null, lowIncome = null;

familyData.forEach(fam => {
  const famSize = fam.famSize || 0;
  const currentIncome = fam.famIncome || 0;

  // Poverty breakdown
  const range = getFamilySizeRange(famSize);
  if (povertyCounts[range] && povertyCounts[range][fam.poverty] !== undefined) {
    povertyCounts[range][fam.poverty] += 1;
  }

  // Totals for averages
  totalFamSize += famSize;
  totalIncome += currentIncome;
  count++;

  // Highest
  if (famSize > highFam) highFam = famSize;
  if (currentIncome > highIncome) highIncome = currentIncome;

  // Lowest (excluding 0)
  if (famSize > 0 && (lowFam === null || famSize < lowFam)) lowFam = famSize;
  if (currentIncome > 0 && (lowIncome === null || currentIncome < lowIncome)) lowIncome = currentIncome;
});

// Adjust lowest values
lowFam = (lowFam === null) ? 0 : lowFam;
lowIncome = (lowIncome === null) ? 0 : lowIncome;

// Final computed values
const aveFam = count > 0 ? (totalFamSize / count).toFixed(2) : 0;
const aveIncome = count > 0 ? (totalIncome / count).toFixed(2) : 0;


  const lat = 15.4869;   // Cabanatuan latitude
  const lon = 120.9730;  // Cabanatuan longitude
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;

console.log("✅ Family Aggregation Complete");
            // Render to EJS
            res.render("dsb", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb",
                weatherCode: weather.current_weather.weathercode,
                pendingCount,
                totalPopulation,
                uniqueHouseholds,
                totalFamilies,
                skVoters,
                registeredVoters,
                businesses,
                maleCount, malePercentage,
                femaleCount, femalePercentage,
                priorityGroups, priorityGroupPercentages, ageGroups, ageGroupPercentages, ageGroups2, ageGroupPercentages2, ageGroups3, ageGroupPercentages3, ageGroups4, ageGroupPercentages4, ageGroups5, ageGroupPercentages5, ageGroups6, ageGroupPercentages6, ageGroups7, ageGroupPercentages7, ageGroups8, ageGroupPercentages8, ageGroups9, ageGroupPercentages9, ageGroups10, ageGroupPercentages10, ageGroups11, ageGroupPercentages11, ageGroups12, ageGroupPercentages12, ageGroups13, ageGroupPercentages13,
                pwdCount, soloParentCount, seniorCitizenCount,indigentCount, nonIndigent, npoorCount, empCount, emp2Count, pregCount,
                 emp3Count, emp4Count, emp5Count, emp6Count, emp7Count,
                pwdPercentage, soloParentPercentage, seniorCitizenPercentage, indigentPercentage, nonIndigentPercentage, npoorPercentage, empPercentage, emp3Percentage, emp4Percentage, emp5Percentage, emp6Percentage, emp7Percentage,
                emp2Percentage, pregPercentage, titlePage,  
  povertyCounts,
  aveFam,
  aveIncome,
  highFam,
  highIncome, lowIncome
            });

        } catch (err) {
            console.error("❌ Error fetching dashboard data:", err);
            res.render("index", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb2",
                error: "Something went wrong!",
            });
        }
    });
 
            
app.get("/dsbBagongDaan", isLogin, sumDoc, sumReq, async (req, res) => {
        
        try {
            const dikeStreetHouseholds = await db.collection("household").find(
                { purok: "Bagong Daan" }, // Filter households by their 'purok' field
                { _id: 1 } // Only retrieve the '_id' field for these households (makes it efficient)
            ).toArray();
            // ✅ Step 2: families with residents included
const familyData = await db.collection("family").aggregate([
  {
    $lookup: {
      from: "household",
      let: { hhId: "$householdId" },
      pipeline: [
        { $match: { $expr: { $eq: ["$_id", { $toObjectId: "$$hhId" }] } } }
      ],
      as: "household"
    }
  },
  { $unwind: "$household" },
  { $match: { "household.purok": "Bagong Daan", archive: { $in: ["0", 0] } } },
  {
    $lookup: {
      from: "resident",
      localField: "_id",
      foreignField: "familyId",
      as: "residents"
    }
  },
  {
    $addFields: {
      famSize: { $size: "$residents" },
      famIncome: { $toInt: "$familyIncome" },
      poverty: "$poverty"
    }
  }
]).toArray();

        // 2. Extract just the '_id' values into an array
            const dikeStreetHouseholdIds = dikeStreetHouseholds.map(h => h._id);

        // --- MODIFY THIS LINE (just adding one condition): ---
        // Now, fetch residents who are active (archive: 0 or "0")
        // AND whose 'householdId' is found in our 'dikeStreetHouseholdIds' array.
            const residents = await db.collection("resident").find({
                archive: { $in: ["0", 0] }, // Your existing filter for active residents
                householdId: { $in: dikeStreetHouseholdIds } // NEW: Filter by associated Dike Street households
            }).toArray();

            const businesses = await db.collection("business").countDocuments({ archive: { $in: ["0", 0] }, purok: "Bagong Daan" });
            const pendingCount = await db.collection("request").countDocuments({ 
                status: { $in: ["Pending", "Processing"] } 
            });
            

            // Total Population
            const totalPopulation = residents.length;

            const householdIdStrings = dikeStreetHouseholds.map(h => h._id.toString());

            const totalFamilies = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            $expr: { 
                $in: [{ $toString: "$householdId" }, householdIdStrings] 
            }
            });
            
            function formatPercentage(value) {
                return value.endsWith(".00") ? parseInt(value) : value;
            }

            // Gender Distribution
            const maleCount = residents.filter(r => r.gender?.toLowerCase() === "male").length;
            const femaleCount = residents.filter(r => r.gender?.toLowerCase() === "female").length;
            const malePercentage = totalPopulation ? formatPercentage(((maleCount / totalPopulation) * 100).toFixed(2)) : "0";
            const femalePercentage = totalPopulation ? formatPercentage(((femaleCount / totalPopulation) * 100).toFixed(2)) : "0";

            // Priority Groups
            const priorityGroups = {
                "Senior Citizen": residents.filter(r => r.priority === "Senior Citizen").length,
                "PWD": residents.filter(r => r.pwd === "on").length,
                "Solo Parent": residents.filter(r => r.soloParent === "on").length,
            };

            // Additional Counts
            const pwdCount = residents.filter(r => r.pwd === "on").length;
            const soloParentCount = residents.filter(r => r.soloParent === "on").length;
            const seniorCitizenCount = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length;
            const pregCount = residents.filter(r => r.pregnant === "on").length;
            const empCount = residents.filter(r => r.employmentStatus === "Employed" ).length;
            const emp2Count = residents.filter(r => r.employmentStatus === "Unemployed" ).length;
            const emp3Count = residents.filter(r => r.employmentStatus === "Self-Employed" ).length;
            const emp4Count = residents.filter(r => r.employmentStatus === "Student" ).length;
            const emp5Count = residents.filter(r => r.employmentStatus === "Dependent" ).length;
            const emp6Count = residents.filter(r => r.employmentStatus === "Pensioner" ).length;
            const emp7Count = residents.filter(r => r.employmentStatus === "Retired" ).length;

            const indigentCount = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Indigent",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            const nonIndigent = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Non-Indigent",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            const npoorCount = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Low Income",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            // PWD, Solo Parent, and Senior Citizen Percentages
            
            const pwdPercentage = totalPopulation ? formatPercentage(((pwdCount / totalPopulation) * 100).toFixed(2)) : "0";
            const soloParentPercentage = totalPopulation ? formatPercentage(((soloParentCount / totalPopulation) * 100).toFixed(2)) : "0";
            const seniorCitizenPercentage = totalPopulation ? formatPercentage(((seniorCitizenCount / totalPopulation) * 100).toFixed(2)) : "0";
            const pregPercentage = totalPopulation ? formatPercentage(((pregCount / totalPopulation) * 100).toFixed(2)) : "0";
            const indigentPercentage = totalFamilies ? formatPercentage(((indigentCount / totalFamilies) * 100).toFixed(2)) : "0";
            const nonIndigentPercentage = totalFamilies ? formatPercentage(((nonIndigent / totalFamilies) * 100).toFixed(2)) : "0";
            const npoorPercentage = totalFamilies ? formatPercentage(((npoorCount / totalFamilies) * 100).toFixed(2)) : "0";
            const empPercentage = totalPopulation ? formatPercentage(((empCount / totalPopulation) * 100).toFixed(2)) : "0";
            const emp2Percentage = totalPopulation ? formatPercentage(((emp2Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp3Percentage = totalPopulation ? formatPercentage(((emp3Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp4Percentage = totalPopulation ? formatPercentage(((emp4Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp5Percentage = totalPopulation ? formatPercentage(((emp5Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp6Percentage = totalPopulation ? formatPercentage(((emp6Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp7Percentage = totalPopulation ? formatPercentage(((emp7Count / totalPopulation) * 100).toFixed(2)) : "0";
            



            // Priority Groups Percentages
            const priorityGroupPercentages = {};
            Object.keys(priorityGroups).forEach(key => {
                priorityGroupPercentages[key] = totalPopulation ? ((priorityGroups[key] / totalPopulation) * 100).toFixed(2) : "0";
            });

            // Function to calculate age from birthdate (Handles Month Names)
            function calculateAge(bMonth, bDay, bYear) {
                if (!bMonth || !bDay || !bYear) return 0;

                // Convert month name to number if needed
                const monthNumber = isNaN(bMonth) ? moment().month(bMonth).format("M") : bMonth;
                return moment().diff(`${bYear}-${monthNumber}-${bDay}`, 'years');
            }


            // Age Distribution
            const ageGroups = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5).length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5).length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5).length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12).length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17).length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59).length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length,
            };

            const ageGroups2 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Male").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Male").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Male").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Male").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Male").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Male").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Male").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Male").length,
            };

            const ageGroups3 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Female").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Female").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Female").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Female").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Female").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Female").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Female").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Female").length,
            };

            // Age Group Percentages
            const ageGroupPercentages = {};
            Object.keys(ageGroups).forEach(key => {
                ageGroupPercentages[key] = totalPopulation ? formatPercentage(((ageGroups[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages2 = {};
            Object.keys(ageGroups2).forEach(key => {
                ageGroupPercentages2[key] = totalPopulation ? formatPercentage(((ageGroups2[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages3 = {};
            Object.keys(ageGroups3).forEach(key => {
                ageGroupPercentages3[key] = totalPopulation ? formatPercentage(((ageGroups3[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

      
            const ageGroups4 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pwd === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pwd === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pwd === "on").length,
            };
            
            
            const ageGroups5 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pregnant === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pregnant === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pregnant === "on").length,
            };

                        
            const ageGroups6 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.soloParent === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.soloParent === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.soloParent === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.soloParent === "on").length,
            };


                        
// Age Group 7 (for reference - note correction for "Senior" as it had `r.pwd === "Employed").employmentStatus` which seems incorrect for counting employed seniors)
const ageGroups7 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Employed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Employed").length, // Corrected assumption: count of employed seniors
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Employed").length,
};

// --- New Age Group Objects ---

// Age Group 8: Unemployed
const ageGroups8 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Unemployed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Unemployed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Unemployed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Unemployed").length,
};


// Age Group 9: Self-Employed
const ageGroups9 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Self-Employed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Self-Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Self-Employed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Self-Employed").length,
};


// Age Group 10: Student
const ageGroups10 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Student").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Student").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Student").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Student").length,
};

// Age Group 11: Dependent
const ageGroups11 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Dependent").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Dependent").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Dependent").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Dependent").length,
};

// Age Group 12: Retired
const ageGroups12 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Retired").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Retired").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Retired").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Retired").length,
};

// Age Group 13: Pensioner
const ageGroups13 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Pensioner").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Pensioner").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Pensioner").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Pensioner").length,
};

// Age Group 4
const ageGroupPercentages4 = {};
Object.keys(ageGroups4).forEach(key => {
    ageGroupPercentages4[key] = totalPopulation ? formatPercentage(((ageGroups4[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 5
const ageGroupPercentages5 = {};
Object.keys(ageGroups5).forEach(key => {
    ageGroupPercentages5[key] = totalPopulation ? formatPercentage(((ageGroups5[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 6
const ageGroupPercentages6 = {};
Object.keys(ageGroups6).forEach(key => {
    ageGroupPercentages6[key] = totalPopulation ? formatPercentage(((ageGroups6[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 7
const ageGroupPercentages7 = {};
Object.keys(ageGroups7).forEach(key => {
    ageGroupPercentages7[key] = totalPopulation ? formatPercentage(((ageGroups7[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 8
const ageGroupPercentages8 = {};
Object.keys(ageGroups8).forEach(key => {
    ageGroupPercentages8[key] = totalPopulation ? formatPercentage(((ageGroups8[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 9
const ageGroupPercentages9 = {};
Object.keys(ageGroups9).forEach(key => {
    ageGroupPercentages9[key] = totalPopulation ? formatPercentage(((ageGroups9[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 10
const ageGroupPercentages10 = {};
Object.keys(ageGroups10).forEach(key => {
    ageGroupPercentages10[key] = totalPopulation ? formatPercentage(((ageGroups10[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 11
const ageGroupPercentages11 = {};
Object.keys(ageGroups11).forEach(key => {
    ageGroupPercentages11[key] = totalPopulation ? formatPercentage(((ageGroups11[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 12
const ageGroupPercentages12 = {};
Object.keys(ageGroups12).forEach(key => {
    ageGroupPercentages12[key] = totalPopulation ? formatPercentage(((ageGroups12[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 13
const ageGroupPercentages13 = {};
Object.keys(ageGroups13).forEach(key => {
    ageGroupPercentages13[key] = totalPopulation ? formatPercentage(((ageGroups13[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

            // Total Households (Unique Addresses: houseNo + purok)
            const uniqueHouseholds = await db.collection("household").countDocuments({ archive: { $in: ["0", 0] }, purok: "Bagong Daan" });


            // SK Voters (15-30 years old with precinct)
            const skVoters = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length;

            // Registered Voters (Residents with a precinct value)
            const registeredVoters = residents.filter(r => r.precinct === "Registered Voter").length;
            const titlePage = "Purok Bagong Daan";
            
// 👇 INSERT FAMILY SIZE + POVERTY BREAKDOWN HERE

const familySizes = await db.collection("resident").aggregate([
    { $match: { 
        archive: { $in: ["0", 0] },
        householdId: { $in: dikeStreetHouseholdIds }
    }},
    { $group: { _id: "$familyId", size: { $sum: 1 } } }
]).toArray();

// Step 2: Map family sizes into ranges
function getFamilySizeRange(size) {
  if (size <= 2) return "1-2";
  if (size <= 4) return "3-4";
  if (size <= 6) return "5-6";
  if (size <= 8) return "7-8";
  return "9 & above";
}

// Poverty result container
const povertyCounts = {
  "1-2": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "3-4": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "5-6": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "7-8": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "9 & above": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 }
};

function getFamilySizeRange(size) {
  if (size <= 2) return "1-2";
  if (size <= 4) return "3-4";
  if (size <= 6) return "5-6";
  if (size <= 8) return "7-8";
  return "9 & above";
}

// Variables for averages and extremes
let totalFamSize = 0, totalIncome = 0, count = 0;
let highFam = 0, highIncome = 0;
let lowFam = null, lowIncome = null;

familyData.forEach(fam => {
  const famSize = fam.famSize || 0;
  const currentIncome = fam.famIncome || 0;

  // Poverty breakdown
  const range = getFamilySizeRange(famSize);
  if (povertyCounts[range] && povertyCounts[range][fam.poverty] !== undefined) {
    povertyCounts[range][fam.poverty] += 1;
  }

  // Totals for averages
  totalFamSize += famSize;
  totalIncome += currentIncome;
  count++;

  // Highest
  if (famSize > highFam) highFam = famSize;
  if (currentIncome > highIncome) highIncome = currentIncome;

  // Lowest (excluding 0)
  if (famSize > 0 && (lowFam === null || famSize < lowFam)) lowFam = famSize;
  if (currentIncome > 0 && (lowIncome === null || currentIncome < lowIncome)) lowIncome = currentIncome;
});

// Adjust lowest values
lowFam = (lowFam === null) ? 0 : lowFam;
lowIncome = (lowIncome === null) ? 0 : lowIncome;

// Final computed values
const aveFam = count > 0 ? (totalFamSize / count).toFixed(2) : 0;
const aveIncome = count > 0 ? (totalIncome / count).toFixed(2) : 0;


  const lat = 15.4869;   // Cabanatuan latitude
  const lon = 120.9730;  // Cabanatuan longitude
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;

console.log("✅ Family Aggregation Complete");
            // Render to EJS
            res.render("dsb", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb",
                weatherCode: weather.current_weather.weathercode,
                pendingCount,
                totalPopulation,
                uniqueHouseholds,
                totalFamilies,
                skVoters,
                registeredVoters,
                businesses,
                maleCount, malePercentage,
                femaleCount, femalePercentage,
                priorityGroups, priorityGroupPercentages, ageGroups, ageGroupPercentages, ageGroups2, ageGroupPercentages2, ageGroups3, ageGroupPercentages3, ageGroups4, ageGroupPercentages4, ageGroups5, ageGroupPercentages5, ageGroups6, ageGroupPercentages6, ageGroups7, ageGroupPercentages7, ageGroups8, ageGroupPercentages8, ageGroups9, ageGroupPercentages9, ageGroups10, ageGroupPercentages10, ageGroups11, ageGroupPercentages11, ageGroups12, ageGroupPercentages12, ageGroups13, ageGroupPercentages13,
                pwdCount, soloParentCount, seniorCitizenCount,indigentCount, nonIndigent, npoorCount, empCount, emp2Count, pregCount,
                 emp3Count, emp4Count, emp5Count, emp6Count, emp7Count,
                pwdPercentage, soloParentPercentage, seniorCitizenPercentage, indigentPercentage, nonIndigentPercentage, npoorPercentage, empPercentage, emp3Percentage, emp4Percentage, emp5Percentage, emp6Percentage, emp7Percentage,
                emp2Percentage, pregPercentage, titlePage,  
  povertyCounts,
  aveFam,
  aveIncome,
  highFam,
  highIncome, lowIncome
            });

        } catch (err) {
            console.error("❌ Error fetching dashboard data:", err);
            res.render("index", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb2",
                error: "Something went wrong!",
            });
        }
    });
 
         
app.get("/dsbHighway", isLogin, sumDoc, sumReq, async (req, res) => {
        
        try {
            const dikeStreetHouseholds = await db.collection("household").find(
                { purok: "Maharlika Highway" }, // Filter households by their 'purok' field
                { _id: 1 } // Only retrieve the '_id' field for these households (makes it efficient)
            ).toArray();
            // ✅ Step 2: families with residents included
const familyData = await db.collection("family").aggregate([
  {
    $lookup: {
      from: "household",
      let: { hhId: "$householdId" },
      pipeline: [
        { $match: { $expr: { $eq: ["$_id", { $toObjectId: "$$hhId" }] } } }
      ],
      as: "household"
    }
  },
  { $unwind: "$household" },
  { $match: { "household.purok": "Maharlika Highway", archive: { $in: ["0", 0] } } },
  {
    $lookup: {
      from: "resident",
      localField: "_id",
      foreignField: "familyId",
      as: "residents"
    }
  },
  {
    $addFields: {
      famSize: { $size: "$residents" },
      famIncome: { $toInt: "$familyIncome" },
      poverty: "$poverty"
    }
  }
]).toArray();

        // 2. Extract just the '_id' values into an array
            const dikeStreetHouseholdIds = dikeStreetHouseholds.map(h => h._id);

        // --- MODIFY THIS LINE (just adding one condition): ---
        // Now, fetch residents who are active (archive: 0 or "0")
        // AND whose 'householdId' is found in our 'dikeStreetHouseholdIds' array.
            const residents = await db.collection("resident").find({
                archive: { $in: ["0", 0] }, // Your existing filter for active residents
                householdId: { $in: dikeStreetHouseholdIds } // NEW: Filter by associated Dike Street households
            }).toArray();

            const businesses = await db.collection("business").countDocuments({ archive: { $in: ["0", 0] }, purok: "Maharlika Highway" });
            const pendingCount = await db.collection("request").countDocuments({ 
                status: { $in: ["Pending", "Processing"] } 
            });
            

            // Total Population
            const totalPopulation = residents.length;

            const householdIdStrings = dikeStreetHouseholds.map(h => h._id.toString());

            const totalFamilies = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            $expr: { 
                $in: [{ $toString: "$householdId" }, householdIdStrings] 
            }
            });
            
            function formatPercentage(value) {
                return value.endsWith(".00") ? parseInt(value) : value;
            }

            // Gender Distribution
            const maleCount = residents.filter(r => r.gender?.toLowerCase() === "male").length;
            const femaleCount = residents.filter(r => r.gender?.toLowerCase() === "female").length;
            const malePercentage = totalPopulation ? formatPercentage(((maleCount / totalPopulation) * 100).toFixed(2)) : "0";
            const femalePercentage = totalPopulation ? formatPercentage(((femaleCount / totalPopulation) * 100).toFixed(2)) : "0";

            // Priority Groups
            const priorityGroups = {
                "Senior Citizen": residents.filter(r => r.priority === "Senior Citizen").length,
                "PWD": residents.filter(r => r.pwd === "on").length,
                "Solo Parent": residents.filter(r => r.soloParent === "on").length,
            };

            // Additional Counts
            const pwdCount = residents.filter(r => r.pwd === "on").length;
            const soloParentCount = residents.filter(r => r.soloParent === "on").length;
            const seniorCitizenCount = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length;
            const pregCount = residents.filter(r => r.pregnant === "on").length;
            const empCount = residents.filter(r => r.employmentStatus === "Employed" ).length;
            const emp2Count = residents.filter(r => r.employmentStatus === "Unemployed" ).length;
            const emp3Count = residents.filter(r => r.employmentStatus === "Self-Employed" ).length;
            const emp4Count = residents.filter(r => r.employmentStatus === "Student" ).length;
            const emp5Count = residents.filter(r => r.employmentStatus === "Dependent" ).length;
            const emp6Count = residents.filter(r => r.employmentStatus === "Pensioner" ).length;
            const emp7Count = residents.filter(r => r.employmentStatus === "Retired" ).length;

            const indigentCount = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Indigent",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            const nonIndigent = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Non-Indigent",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            const npoorCount = await db.collection("family").countDocuments({
            archive: { $in: ["0", 0] },
            poverty: "Low Income",
            $expr: { $in: [{ $toString: "$householdId" }, householdIdStrings] }
            });

            // PWD, Solo Parent, and Senior Citizen Percentages
            
            const pwdPercentage = totalPopulation ? formatPercentage(((pwdCount / totalPopulation) * 100).toFixed(2)) : "0";
            const soloParentPercentage = totalPopulation ? formatPercentage(((soloParentCount / totalPopulation) * 100).toFixed(2)) : "0";
            const seniorCitizenPercentage = totalPopulation ? formatPercentage(((seniorCitizenCount / totalPopulation) * 100).toFixed(2)) : "0";
            const pregPercentage = totalPopulation ? formatPercentage(((pregCount / totalPopulation) * 100).toFixed(2)) : "0";
            const indigentPercentage = totalFamilies ? formatPercentage(((indigentCount / totalFamilies) * 100).toFixed(2)) : "0";
            const nonIndigentPercentage = totalFamilies ? formatPercentage(((nonIndigent / totalFamilies) * 100).toFixed(2)) : "0";
            const npoorPercentage = totalFamilies ? formatPercentage(((npoorCount / totalFamilies) * 100).toFixed(2)) : "0";
            const empPercentage = totalPopulation ? formatPercentage(((empCount / totalPopulation) * 100).toFixed(2)) : "0";
            const emp2Percentage = totalPopulation ? formatPercentage(((emp2Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp3Percentage = totalPopulation ? formatPercentage(((emp3Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp4Percentage = totalPopulation ? formatPercentage(((emp4Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp5Percentage = totalPopulation ? formatPercentage(((emp5Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp6Percentage = totalPopulation ? formatPercentage(((emp6Count / totalPopulation) * 100).toFixed(2)) : "0";
            const emp7Percentage = totalPopulation ? formatPercentage(((emp7Count / totalPopulation) * 100).toFixed(2)) : "0";
            



            // Priority Groups Percentages
            const priorityGroupPercentages = {};
            Object.keys(priorityGroups).forEach(key => {
                priorityGroupPercentages[key] = totalPopulation ? ((priorityGroups[key] / totalPopulation) * 100).toFixed(2) : "0";
            });

            // Function to calculate age from birthdate (Handles Month Names)
            function calculateAge(bMonth, bDay, bYear) {
                if (!bMonth || !bDay || !bYear) return 0;

                // Convert month name to number if needed
                const monthNumber = isNaN(bMonth) ? moment().month(bMonth).format("M") : bMonth;
                return moment().diff(`${bYear}-${monthNumber}-${bDay}`, 'years');
            }


            // Age Distribution
            const ageGroups = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5).length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5).length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5).length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12).length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17).length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59).length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60).length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length,
            };

            const ageGroups2 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Male").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Male").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Male").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Male").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Male").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Male").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Male").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Male").length,
            };

            const ageGroups3 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.gender === "Female").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.gender === "Female").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.gender === "Female").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.gender === "Female").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.gender === "Female").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.gender === "Female").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.gender === "Female").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.gender === "Female").length,
            };

            // Age Group Percentages
            const ageGroupPercentages = {};
            Object.keys(ageGroups).forEach(key => {
                ageGroupPercentages[key] = totalPopulation ? formatPercentage(((ageGroups[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages2 = {};
            Object.keys(ageGroups2).forEach(key => {
                ageGroupPercentages2[key] = totalPopulation ? formatPercentage(((ageGroups2[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

            const ageGroupPercentages3 = {};
            Object.keys(ageGroups3).forEach(key => {
                ageGroupPercentages3[key] = totalPopulation ? formatPercentage(((ageGroups3[key] / totalPopulation) * 100).toFixed(2)) : "0";
            });

      
            const ageGroups4 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pwd === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pwd === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pwd === "on").length,
            };
            
            
            const ageGroups5 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.pregnant === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.pregnant === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.pwd === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.pregnant === "on").length,
            };

                        
            const ageGroups6 = {
                "0-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) <= 5 && r.pwd === "on").length,
                "6-11": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) < 1 && (parseInt(r.bMonth) || 0) > 5 && r.pwd === "on").length,
                "1-5": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 1 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 5 && r.pwd === "on").length,
                "6-12": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 6 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 12 && r.pwd === "on").length,
                "13-17": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.soloParent === "on").length,
                "18-59": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.soloParent === "on").length,
                "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.soloParent === "on").length,
                "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.soloParent === "on").length,
            };


                        
// Age Group 7 (for reference - note correction for "Senior" as it had `r.pwd === "Employed").employmentStatus` which seems incorrect for counting employed seniors)
const ageGroups7 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Employed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Employed").length, // Corrected assumption: count of employed seniors
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Employed").length,
};

// --- New Age Group Objects ---

// Age Group 8: Unemployed
const ageGroups8 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Unemployed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Unemployed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Unemployed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Unemployed").length,
};


// Age Group 9: Self-Employed
const ageGroups9 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Self-Employed").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Self-Employed").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Self-Employed").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Self-Employed").length,
};


// Age Group 10: Student
const ageGroups10 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Student").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Student").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Student").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Student").length,
};

// Age Group 11: Dependent
const ageGroups11 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Dependent").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Dependent").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Dependent").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Dependent").length,
};

// Age Group 12: Retired
const ageGroups12 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Retired").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Retired").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Retired").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Retired").length,
};

// Age Group 13: Pensioner
const ageGroups13 = {
    "13-17years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 13 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 17 && r.employmentStatus === "Pensioner").length,
    "18-59years": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 18 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 59 && r.employmentStatus === "Pensioner").length,
    "Senior": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 60 && r.employmentStatus === "Pensioner").length,
    "Youth": residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct && r.employmentStatus === "Pensioner").length,
};

// Age Group 4
const ageGroupPercentages4 = {};
Object.keys(ageGroups4).forEach(key => {
    ageGroupPercentages4[key] = totalPopulation ? formatPercentage(((ageGroups4[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 5
const ageGroupPercentages5 = {};
Object.keys(ageGroups5).forEach(key => {
    ageGroupPercentages5[key] = totalPopulation ? formatPercentage(((ageGroups5[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 6
const ageGroupPercentages6 = {};
Object.keys(ageGroups6).forEach(key => {
    ageGroupPercentages6[key] = totalPopulation ? formatPercentage(((ageGroups6[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 7
const ageGroupPercentages7 = {};
Object.keys(ageGroups7).forEach(key => {
    ageGroupPercentages7[key] = totalPopulation ? formatPercentage(((ageGroups7[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 8
const ageGroupPercentages8 = {};
Object.keys(ageGroups8).forEach(key => {
    ageGroupPercentages8[key] = totalPopulation ? formatPercentage(((ageGroups8[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 9
const ageGroupPercentages9 = {};
Object.keys(ageGroups9).forEach(key => {
    ageGroupPercentages9[key] = totalPopulation ? formatPercentage(((ageGroups9[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 10
const ageGroupPercentages10 = {};
Object.keys(ageGroups10).forEach(key => {
    ageGroupPercentages10[key] = totalPopulation ? formatPercentage(((ageGroups10[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 11
const ageGroupPercentages11 = {};
Object.keys(ageGroups11).forEach(key => {
    ageGroupPercentages11[key] = totalPopulation ? formatPercentage(((ageGroups11[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 12
const ageGroupPercentages12 = {};
Object.keys(ageGroups12).forEach(key => {
    ageGroupPercentages12[key] = totalPopulation ? formatPercentage(((ageGroups12[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

// Age Group 13
const ageGroupPercentages13 = {};
Object.keys(ageGroups13).forEach(key => {
    ageGroupPercentages13[key] = totalPopulation ? formatPercentage(((ageGroups13[key] / totalPopulation) * 100).toFixed(2)) : "0";
});

            // Total Households (Unique Addresses: houseNo + purok)
            const uniqueHouseholds = await db.collection("household").countDocuments({ archive: { $in: ["0", 0] }, purok: "Maharlika Highway" });


            // SK Voters (15-30 years old with precinct)
            const skVoters = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length;

            // Registered Voters (Residents with a precinct value)
            const registeredVoters = residents.filter(r => r.precinct === "Registered Voter").length;
            const titlePage = "Maharlika Highway";
            
// 👇 INSERT FAMILY SIZE + POVERTY BREAKDOWN HERE

const familySizes = await db.collection("resident").aggregate([
    { $match: { 
        archive: { $in: ["0", 0] },
        householdId: { $in: dikeStreetHouseholdIds }
    }},
    { $group: { _id: "$familyId", size: { $sum: 1 } } }
]).toArray();

// Step 2: Map family sizes into ranges
function getFamilySizeRange(size) {
  if (size <= 2) return "1-2";
  if (size <= 4) return "3-4";
  if (size <= 6) return "5-6";
  if (size <= 8) return "7-8";
  return "9 & above";
}

// Poverty result container
const povertyCounts = {
  "1-2": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "3-4": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "5-6": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "7-8": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 },
  "9 & above": { Indigent: 0, "Non-Indigent": 0, "Low Income": 0 }
};

function getFamilySizeRange(size) {
  if (size <= 2) return "1-2";
  if (size <= 4) return "3-4";
  if (size <= 6) return "5-6";
  if (size <= 8) return "7-8";
  return "9 & above";
}

// Variables for averages and extremes
let totalFamSize = 0, totalIncome = 0, count = 0;
let highFam = 0, highIncome = 0;
let lowFam = null, lowIncome = null;

familyData.forEach(fam => {
  const famSize = fam.famSize || 0;
  const currentIncome = fam.famIncome || 0;

  // Poverty breakdown
  const range = getFamilySizeRange(famSize);
  if (povertyCounts[range] && povertyCounts[range][fam.poverty] !== undefined) {
    povertyCounts[range][fam.poverty] += 1;
  }

  // Totals for averages
  totalFamSize += famSize;
  totalIncome += currentIncome;
  count++;

  // Highest
  if (famSize > highFam) highFam = famSize;
  if (currentIncome > highIncome) highIncome = currentIncome;

  // Lowest (excluding 0)
  if (famSize > 0 && (lowFam === null || famSize < lowFam)) lowFam = famSize;
  if (currentIncome > 0 && (lowIncome === null || currentIncome < lowIncome)) lowIncome = currentIncome;
});

// Adjust lowest values
lowFam = (lowFam === null) ? 0 : lowFam;
lowIncome = (lowIncome === null) ? 0 : lowIncome;

// Final computed values
const aveFam = count > 0 ? (totalFamSize / count).toFixed(2) : 0;
const aveIncome = count > 0 ? (totalIncome / count).toFixed(2) : 0;


  const lat = 15.4869;   // Cabanatuan latitude
  const lon = 120.9730;  // Cabanatuan longitude
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true`;

console.log("✅ Family Aggregation Complete");
            // Render to EJS
            res.render("dsb", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb",
                weatherCode: weather.current_weather.weathercode,
                pendingCount,
                totalPopulation,
                uniqueHouseholds,
                totalFamilies,
                skVoters,
                registeredVoters,
                businesses,
                maleCount, malePercentage,
                femaleCount, femalePercentage,
                priorityGroups, priorityGroupPercentages, ageGroups, ageGroupPercentages, ageGroups2, ageGroupPercentages2, ageGroups3, ageGroupPercentages3, ageGroups4, ageGroupPercentages4, ageGroups5, ageGroupPercentages5, ageGroups6, ageGroupPercentages6, ageGroups7, ageGroupPercentages7, ageGroups8, ageGroupPercentages8, ageGroups9, ageGroupPercentages9, ageGroups10, ageGroupPercentages10, ageGroups11, ageGroupPercentages11, ageGroups12, ageGroupPercentages12, ageGroups13, ageGroupPercentages13,
                pwdCount, soloParentCount, seniorCitizenCount,indigentCount, nonIndigent, npoorCount, empCount, emp2Count, pregCount,
                 emp3Count, emp4Count, emp5Count, emp6Count, emp7Count,
                pwdPercentage, soloParentPercentage, seniorCitizenPercentage, indigentPercentage, nonIndigentPercentage, npoorPercentage, empPercentage, emp3Percentage, emp4Percentage, emp5Percentage, emp6Percentage, emp7Percentage,
                emp2Percentage, pregPercentage, titlePage,  
  povertyCounts,
  aveFam,
  aveIncome,
  highFam,
  highIncome, lowIncome
            });

        } catch (err) {
            console.error("❌ Error fetching dashboard data:", err);
            res.render("index", {
                layout: "layout",
                title: "Dashboard",
                activePage: "dsb2",
                error: "Something went wrong!",
            });
        }
    });
 
 
app.get("/exportPDF", isLogin, async (req, res) => {
    try {
        // Fetch data from MongoDB
        const residents = await db.collection("resident").find({ archive: { $in: ["0", 0] } }).toArray();
        const businesses = await db.collection("business").countDocuments({ archive: { $in: ["0", 0] } });
        const pendingCount = await db.collection("request").countDocuments({ status: { $in: ["Pending", "Processing"] } });

        const totalPopulation = residents.length;
        const maleCount = residents.filter(r => r.gender?.toLowerCase() === "male").length;
        const femaleCount = residents.filter(r => r.gender?.toLowerCase() === "female").length;
        const uniqueHouseholds = new Set(residents.map(r => `${r.houseNo || ""}-${r.purok || ""}`)).size;
        const totalFamilies = residents.filter(r => r.role?.toLowerCase() === "head").length;
        const skVoters = residents.filter(r => calculateAge(r.bMonth, r.bDay, r.bYear) >= 15 && calculateAge(r.bMonth, r.bDay, r.bYear) <= 30 && r.precinct).length;
        const registeredVoters = residents.filter(r => r.precinct).length;

        // Age Distribution
        const ageGroups = {
            "0-5 Months": 0,
            "6-11 Months": 0,
            "1-5 Years Old": 0,
            "6-12 Years Old": 0,
            "13-17 Years Old": 0,
            "18-59 Years Old": 0,
            "15-30 (SK Voters)": 0,
            "59 & Above (Senior Citizen)": 0
        };

        residents.forEach(r => {
            const age = calculateAge(r.bMonth, r.bDay, r.bYear);
            if (age < 1) {
                const monthsOld = moment().diff(`${r.bYear}-${r.bMonth}-${r.bDay}`, "months");
                if (monthsOld <= 5) ageGroups["0-5 Months"]++;
                else ageGroups["6-11 Months"]++;
            } else if (age >= 1 && age <= 5) ageGroups["1-5 Years Old"]++;
            else if (age >= 6 && age <= 12) ageGroups["6-12 Years Old"]++;
            else if (age >= 13 && age <= 17) ageGroups["13-17 Years Old"]++;
            else if (age >= 18 && age <= 59) ageGroups["18-59 Years Old"]++;
            if (age >= 15 && age <= 30) ageGroups["15-30 (SK Voters)"]++;
            if (age >= 59) ageGroups["59 & Above (Senior Citizen)"]++;
        });

        // Calculate Percentages
        const calcPercentage = (count) => (totalPopulation > 0 ? ((count / totalPopulation) * 100).toFixed(2) : "0.00");

        // Create PDF Document
        const doc = new PDFDocument({ margin: 50 });
        const fileName = `Dashboard_Report_${Date.now()}.pdf`;
        const filePath = path.join(__dirname, "public", "reports", fileName);

        // Ensure reports directory exists
        if (!fs.existsSync(path.join(__dirname, "public", "reports"))) {
            fs.mkdirSync(path.join(__dirname, "public", "reports"), { recursive: true });
        }

        const writeStream = fs.createWriteStream(filePath);
        doc.pipe(writeStream);

        // Add Title
        doc.fontSize(20).fillColor("#1F4E79").text("Dashboard Report", { align: "center" }).moveDown(1);

        // Table Styling
        let x = 50;
        let y = 120;
        const rowHeight = 25;
        const colWidths = [200, 100, 100];

        // Draw table headers with background color
        doc.fillColor("#FFFFFF").fontSize(12).text("Category", x + 10, y, { bold: true });
        doc.text("Count", x + colWidths[0] + 10, y, { bold: true });
        doc.text("Percentage", x + colWidths[0] + colWidths[1] + 10, y, { bold: true });

        doc.rect(x, y - 5, colWidths[0] + colWidths[1] + colWidths[2], rowHeight)
            .fill("#9bf6c6ff")
            .stroke();

        doc.fillColor("#000000");

        y += rowHeight;

        // General Statistics
        addTableRow(doc, x, y, "Total Population", totalPopulation, "100%");
        addTableRow(doc, x, y += rowHeight, "Male Residents", maleCount, `${calcPercentage(maleCount)}%`);
        addTableRow(doc, x, y += rowHeight, "Female Residents", femaleCount, `${calcPercentage(femaleCount)}%`);
        addTableRow(doc, x, y += rowHeight, "Total Households", uniqueHouseholds, `${calcPercentage(uniqueHouseholds)}%`);
        addTableRow(doc, x, y += rowHeight, "Total Families", totalFamilies, `${calcPercentage(totalFamilies)}%`);
        addTableRow(doc, x, y += rowHeight, "Total Businesses", businesses, `${calcPercentage(businesses)}%`);
        addTableRow(doc, x, y += rowHeight, "Registered Voters", registeredVoters, `${calcPercentage(registeredVoters)}%`);
        addTableRow(doc, x, y += rowHeight, "SK Voters", skVoters, `${calcPercentage(skVoters)}%`);
        y += rowHeight * 2; // Space before Age Distribution
doc.fontSize(14).fillColor("#9bf6c6ff").text("Age Distribution", x, y).moveDown(1);
doc.fillColor("#000000").fontSize(12);

Object.keys(ageGroups).forEach((group) => {
    addTableRow(doc, x, y += rowHeight, group, ageGroups[group], `${calcPercentage(ageGroups[group])}%`);
});

        

        // Finalize PDF
        doc.end();

        writeStream.on("finish", () => {
            res.download(filePath, fileName, (err) => {
                if (err) console.error("❌ Error downloading PDF:", err);
                fs.unlinkSync(filePath); // Delete file after download
            });
        });

    } catch (err) {
        console.error("❌ Error generating PDF:", err);
        res.status(500).send('<script>alert("Failed to generate PDF!"); window.location="/dsb";</script>');
    }
});

// Function to add styled rows to the PDF table
function addTableRow(doc, x, y, label, count, percentage) {
    const rowHeight = 25;
    const colWidths = [200, 100, 100];

    doc.rect(x, y, colWidths[0] + colWidths[1] + colWidths[2], rowHeight)
        .stroke();

    doc.fillColor("#000000").fontSize(12);
    doc.text(label, x + 10, y + 5);
    doc.text(count.toString(), x + colWidths[0] + 10, y + 5);
    doc.text(percentage, x + colWidths[0] + colWidths[1] + 10, y + 5);
}

function calculateAge(bMonth, bDay, bYear) {
    if (!bMonth || !bDay || !bYear) return 0;

    // Convert to integers if they come in as strings
    const year = parseInt(bYear, 10);
    const monthIndex = parseInt(bMonth, 10) - 1; // 0-based for moment
    const day = parseInt(bDay, 10);

    const birthDate = moment([year, monthIndex, day]);
    if (!birthDate.isValid()) return 0;

    return moment().diff(birthDate, 'years');
}

app.get("/getRequestCount", async (req, res) => {
    try {
        const requestCount = await db.collection("request").countDocuments({});
        res.json({ count: requestCount });
    } catch (err) {
        console.error("Error fetching request count:", err);
        res.status(500).json({ count: 0 });
    }
});

app.get("/getPendingCount", async (req, res) => {
    try {
        const pendingCount = await db.collection("request").countDocuments({ status: "Pending" });
        res.json({ count: pendingCount });
    } catch (err) {
        console.error("Error fetching pending count:", err);
        res.status(500).json({ count: 0 });
    }
});

const myReqView = async (req, res) => {
    try {
        if (!req.user) {
            console.log("User is not logged in.");
            return res.redirect("/");
        }

        const requestId = req.params.id;
        console.log("🔎 Request ID:", requestId);

        if (!ObjectId.isValid(requestId)) {
            console.log("❌ Invalid request ID format.");
            return res.status(400).send("Invalid request ID.");
        }

        const objectIdRequestId = new ObjectId(requestId);

        // Ensure sessionUserId is an ObjectId
        let sessionUserId = req.user._id;
        if (typeof sessionUserId === "string" && ObjectId.isValid(sessionUserId)) {
            sessionUserId = new ObjectId(sessionUserId);
        }

        console.log("✅ Converted sessionUserId:", sessionUserId);

        // Fetch the specific request
        const request = await db.collection("request").findOne({
            _id: objectIdRequestId,
            requestBy: sessionUserId,  // Ensure this matches the stored ObjectId
            archive: { $in: [0, "0"] } // Ensure not archived
        });

        if (!request) {
            console.log("❌ Request not found.");
            return res.status(404).send("Request not found.");
        }

        console.log("✅ Request Found:", request);

        // Fetch resident details (where requestBy matches resident._id)
        let resident = null;
        if (request.requestBy) {
            resident = await db.collection("resident").findOne({
                _id: new ObjectId(request.requestBy)
            });
        }

        console.log("👤 Resident Found:", resident);

        // Fetch all documents related to this request
        const documents = await db.collection("document")
            .find({ reqId: objectIdRequestId })
            .toArray();

        console.log(`📄 Documents Found: ${documents.length}`);

        // Attach documents to the request object
        request.documents = documents;

        // Render the EJS page with the data
        res.render("reqView", { request, resident, documents });

    } catch (err) {
        console.error("⚠️ Error in myReqView:", err);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
};

const myReqView2 = async (req, res) => {
    try {
        if (!req.user) {
            console.log("User is not logged in.");
            return res.redirect("/");
        }

        const requestId = req.params.id;
        console.log("🔎 Request ID:", requestId);

        if (!ObjectId.isValid(requestId)) {
            console.log("❌ Invalid request ID format.");
            return res.status(400).send("Invalid request ID.");
        }

        const objectIdRequestId = new ObjectId(requestId);

        // Ensure sessionUserId is an ObjectId
        let sessionUserId = req.user._id;
        if (typeof sessionUserId === "string" && ObjectId.isValid(sessionUserId)) {
            sessionUserId = new ObjectId(sessionUserId);
        }

        console.log("✅ Converted sessionUserId:", sessionUserId);

        // Fetch the specific request
        const request = await db.collection("request").findOne({
            _id: objectIdRequestId,
            requestBy: sessionUserId,  // Ensure this matches the stored ObjectId
            archive: { $in: [0, "0"] } // Ensure not archived
        });

        if (!request) {
            console.log("❌ Request not found.");
            return res.status(404).send("Request not found.");
        }

        console.log("✅ Request Found:", request);

        // Fetch resident details (where requestBy matches resident._id)
        let resident = null;
        if (request.requestBy) {
            resident = await db.collection("resident").findOne({
                _id: new ObjectId(request.requestBy)
            });
        }

        console.log("👤 Resident Found:", resident);

        // Fetch all documents related to this request
        const documents = await db.collection("document")
            .find({ reqId: objectIdRequestId })
            .toArray();

        console.log(`📄 Documents Found: ${documents.length}`);

        // Attach documents to the request object
        request.documents = documents;

        // Render the EJS page with the data
        res.render("reqView2", { request, resident, documents });

    } catch (err) {
        console.error("⚠️ Error in myReqView2:", err);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
};


const myReqView3 = async (req, res) => {
    try {
        if (!req.user) {
            console.log("User is not logged in.");
            return res.redirect("/");
        }

        const requestId = req.params.id;
        console.log("🔎 Request ID:", requestId);

        if (!ObjectId.isValid(requestId)) {
            console.log("❌ Invalid request ID format.");
            return res.status(400).send("Invalid request ID.");
        }

        const objectIdRequestId = new ObjectId(requestId);

        // Ensure sessionUserId is an ObjectId
        let sessionUserId = req.user._id;
        if (typeof sessionUserId === "string" && ObjectId.isValid(sessionUserId)) {
            sessionUserId = new ObjectId(sessionUserId);
        }

        console.log("✅ Converted sessionUserId:", sessionUserId);

        // Fetch the specific request
        const request = await db.collection("request").findOne({
            _id: objectIdRequestId,
            requestBy: sessionUserId,  // Ensure this matches the stored ObjectId
            archive: { $in: [0, "0"] } // Ensure not archived
        });

        if (!request) {
            console.log("❌ Request not found.");
            return res.status(404).send("Request not found.");
        }

        console.log("✅ Request Found:", request);

        // Fetch resident details (where requestBy matches resident._id)
        let resident = null;
        if (request.requestBy) {
            resident = await db.collection("resident").findOne({
                _id: new ObjectId(request.requestBy)
            });
        }

        console.log("👤 Resident Found:", resident);

        // Fetch all documents related to this request
        const documents = await db.collection("document")
            .find({ reqId: objectIdRequestId })
            .toArray();

        console.log(`📄 Documents Found: ${documents.length}`);

        // Attach documents to the request object
        request.documents = documents;

        // Render the EJS page with the data
        res.render("docView", { request, resident, documents, title: "Document", activePage: "dsb" });

    } catch (err) {
        console.error("⚠️ Error in myReqView2:", err);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
};

app.get('/authLetter', (req, res) => {
    const filePath = path.join(__dirname, 'public', 'files', 'au.pdf');
    res.download(filePath, 'Authorization_Letter.pdf', (err) => {
        if (err) {
            console.error('Error downloading file:', err);
            return res.status(500).send('Error downloading file');
        }
        res.end(); // Explicitly end the response
    });
});
app.get('/downloadAuthLetter', (req, res) => {
    res.send(`
        <html>
        <head>
            <script>
                window.onload = function() {
                    // Trigger the download
                    const downloadLink = document.createElement('a');
                    downloadLink.href = '/authLetter';
                    downloadLink.download = 'Authorization_Letter.pdf';
                    document.body.appendChild(downloadLink);
                    downloadLink.click();
                    document.body.removeChild(downloadLink);

                    // Redirect back after a short delay
                    setTimeout(() => {
                        window.history.back(); // Go back to the previous page
                    }, 1000);
                };
            </script>
        </head>
        <body>
            <p>Downloading Authorization Letter...</p>
        </body>
        </html>
    `);
});

app.get('/reqView/:id', isLogin, myReqView);
app.get('/reqView2/:id', isLogin, myReqView2);
app.get('/docView/:id', isLogin, myReqView3);
app.get('/cct', isRsd, (req, res) => { res.render("cct" , { layout: "layout", title: "Access", activePage: "cct" })});

app.get("/export-residents", isLogin, (req, res) => {
    res.render("downloading", { title: "", layout: "layout", activePage: ""});
});


app.get("/download-residents", isLogin, async (req, res) => {
    try {
        const residents = await db.collection("resident").aggregate([
            {
                $lookup: {
                    from: "household",
                    localField: "householdId",
                    foreignField: "_id",
                    as: "householdInfo"
                }
            },
            {
                $unwind: {
                    path: "$householdInfo",
                    preserveNullAndEmptyArrays: true
                }
            }
        ]).toArray();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Residents");

// 🟢 Add a title row
worksheet.mergeCells("A1:T1"); // adjust range according to last column
worksheet.getCell("A1").value = "Barangay Valdefuente - Residents List";
worksheet.getCell("A1").font = { size: 16, bold: true };
worksheet.getCell("A1").alignment = { vertical: "middle", horizontal: "center" };

// 🟢 Add a subtitle row
worksheet.mergeCells("A2:T2");
worksheet.getCell("A2").value = `Generated on: ${new Date().toLocaleDateString()}`;
worksheet.getCell("A2").font = { size: 12, italic: true };
worksheet.getCell("A2").alignment = { vertical: "middle", horizontal: "center" };

// 🟢 Leave one empty row
worksheet.addRow([]);

// 🟢 Define columns without auto header row
worksheet.columns = [
    { key: "completeName", width: 25 },
    { key: "address", width: 25 },
    { key: "birthday", width: 20 },
    { key: "birthPlace", width: 20 },
    { key: "phone", width: 15 },
    { key: "email", width: 25 },
    { key: "gender", width: 10 },
    { key: "civilStatus", width: 15 },
    { key: "precinct", width: 15 },
    { key: "role", width: 15 },
    { key: "priority", width: 15 },
    { key: "priorityType", width: 20 },
    { key: "pregnant", width: 12 },
    { key: "soloParent", width: 15 },
    { key: "pwd", width: 10 },
    { key: "pwdType", width: 15 },
    { key: "employmentStatus", width: 20 },
    { key: "work", width: 20 },
    { key: "monthlyIncome", width: 15 },
    { key: "position", width: 20 }
];

// 🟢 Manually add header row
worksheet.addRow([
    "Complete Name", "Address", "Birthday", "Birth Place", "Phone", "Email",
    "Gender", "Civil Status", "Precinct", "Role", "Priority", "Priority Type",
    "Pregnant", "Solo Parent", "PWD", "PWD Type", "Employment Status", "Work",
    "Monthly Income", "Position"
]);

// Style header row
const headerRow = worksheet.lastRow;
headerRow.font = { bold: true };
headerRow.alignment = { vertical: "center", horizontal: "center" };
headerRow.eachCell(cell => {
    cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFD9D9D9" } // light gray background
    };
    cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" }
    };
});
        const convertYesNo = (value) => {
            if (value === "on") return "Yes";
            if (value === "off") return "No";
            return value ?? "";
        };

        const formattedData = residents.map(resident => {
            const household = resident.householdInfo || {};
            const houseNo = household.houseNo || "";
            const purok = household.purok || "";

            let birthday = "";
            if (resident.bMonth && resident.bDay && resident.bYear) {
                const month =
                    isNaN(resident.bMonth) && typeof resident.bMonth === "string"
                        ? resident.bMonth
                        : new Date(0, parseInt(resident.bMonth) - 1).toLocaleString("en-US", { month: "long" });

                birthday = `${month} ${resident.bDay}, ${resident.bYear}`;
            }

            return {
                completeName: `${resident.firstName} ${resident.middleName || ""} ${resident.lastName} ${resident.extName || ""}`.trim(),
                address: `${houseNo}, Purok ${purok}`,
                birthday,
                birthPlace: resident.birthPlace || "",
                phone: resident.phone || "",
                email: resident.email || "",
                gender: resident.gender || "",
                civilStatus: resident.civilStatus || "",
                precinct: resident.precinct || "",
                role: resident.role || "",
                priority: resident.priority || "",
                priorityType: resident.priorityType || "",
                pregnant: convertYesNo(resident.pregnant),
                soloParent: convertYesNo(resident.soloParent),
                pwd: convertYesNo(resident.pwd),
                pwdType: resident.pwdType || "",
                employmentStatus: resident.employmentStatus || "",
                work: resident.work || "",
                monthlyIncome: resident.monthlyIncome || "",
                position: resident.position || ""
            };
        });

        worksheet.addRows(formattedData);

        const buffer = await workbook.xlsx.writeBuffer();

        res.setHeader("Content-Disposition", "attachment; filename=residents.xlsx");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

        res.send(Buffer.from(buffer));
    } catch (error) {
        console.error("❌ Error exporting residents:", error);
        res.status(500).json({ message: "Error exporting residents data." });
    }
});


app.get("/export-residents2", isLogin, (req, res) => {
    res.render("downloading2", { title: "", layout: "layout", activePage: ""} );
});

app.get("/download-residents2", isLogin, async (req, res) => {
    try {
        const residents = await db.collection("resident").find().toArray();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Residents");

// 🟢 Add a title row
worksheet.mergeCells("A1:T1"); // adjust range according to last column
worksheet.getCell("A1").value = "Barangay Valdefuente - Residents List";
worksheet.getCell("A1").font = { size: 16, bold: true };
worksheet.getCell("A1").alignment = { vertical: "middle", horizontal: "center" };

// 🟢 Add a subtitle row
worksheet.mergeCells("A2:T2");
worksheet.getCell("A2").value = `Generated on: ${new Date().toLocaleDateString()}`;
worksheet.getCell("A2").font = { size: 12, italic: true };
worksheet.getCell("A2").alignment = { vertical: "middle", horizontal: "center" };

// 🟢 Leave one empty row
worksheet.addRow([]);

// 🟢 Define columns without auto header row
worksheet.columns = [
    { key: "completeName", width: 25 },
    { key: "address", width: 25 },
    { key: "birthday", width: 20 },
    { key: "birthPlace", width: 20 },
    { key: "phone", width: 15 },
    { key: "email", width: 25 },
    { key: "gender", width: 10 },
    { key: "civilStatus", width: 15 },
    { key: "precinct", width: 15 },
    { key: "role", width: 15 },
    { key: "priority", width: 15 },
    { key: "priorityType", width: 20 },
    { key: "pregnant", width: 12 },
    { key: "soloParent", width: 15 },
    { key: "pwd", width: 10 },
    { key: "pwdType", width: 15 },
    { key: "employmentStatus", width: 20 },
    { key: "work", width: 20 },
    { key: "monthlyIncome", width: 15 },
    { key: "position", width: 20 }
];

// 🟢 Manually add header row
worksheet.addRow([
    "Complete Name", "Address", "Birthday", "Birth Place", "Phone", "Email",
    "Gender", "Civil Status", "Precinct", "Role", "Priority", "Priority Type",
    "Pregnant", "Solo Parent", "PWD", "PWD Type", "Employment Status", "Work",
    "Monthly Income", "Position"
]);

// Style header row
const headerRow = worksheet.lastRow;
headerRow.font = { bold: true };
headerRow.alignment = { vertical: "center", horizontal: "center" };
headerRow.eachCell(cell => {
    cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFD9D9D9" } // light gray background
    };
    cell.border = {
        top: { style: "thin" },
        left: { style: "thin" },
        bottom: { style: "thin" },
        right: { style: "thin" }
    };
});
        const monthNames = [
            "", "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ];

        const formattedData = [];

        for (const resident of residents) {
            let houseNo = "";
            let purok = "";

            if (resident.householdId) {
                const household = await db.collection("household").findOne({ _id: new ObjectId(resident.householdId) });
                if (household) {
                    houseNo = household.houseNo || "";
                    purok = household.purok || "";
                }
            }

            const monthIndex = parseInt(resident.bMonth); // Convert to number
            const monthName = !isNaN(monthIndex) && monthIndex >= 1 && monthIndex <= 12 ? monthNames[monthIndex] : "";
            const birthday = `${monthName} ${resident.bDay || ""}, ${resident.bYear || ""}`;

            const formatSwitch = (val) => val === "on" ? "Yes" : val === "off" ? "No" : "";

            formattedData.push({
                completeName: `${resident.firstName} ${resident.middleName || ""} ${resident.lastName} ${resident.extName || ""}`.trim(),
                address: `${houseNo}, Purok ${purok}`,
                birthday,
                birthPlace: resident.birthPlace || "",
                phone: resident.phone || "",
                email: resident.email || "",
                gender: resident.gender || "",
                civilStatus: resident.civilStatus || "",
                precinct: resident.precinct || "",
                role: resident.role || "",
                pwd: formatSwitch(resident.pwd),
                pwdType: resident.pwdType || "",
                pregnant: formatSwitch(resident.pregnant),
                soloParent: formatSwitch(resident.soloParent),
                priorityType: resident.priorityType || "",
                employmentStatus: resident.employmentStatus || "",
                work: resident.work || "",
                monthlyIncome: resident.monthlyIncome || "",
                position: resident.position || ""
            });
        }

        worksheet.addRows(formattedData);

        const buffer = await workbook.xlsx.writeBuffer();

        res.setHeader("Content-Disposition", "attachment; filename=residents.xlsx");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
        res.send(Buffer.from(buffer));

    } catch (error) {
        console.error("❌ Error exporting residents:", error);
        res.status(500).json({ message: "Error exporting residents data." });
    }
});

app.get("/export-business", isLogin, (req, res) => {
    res.render("exporting", { title: "", layout: "layout", activePage: ""} );
});


app.get("/download-business", async (req, res) => {
    try {
        const businesses = await db.collection("business").find().toArray();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Businesses");

        // Define the columns
        worksheet.columns = [
            { header: "Name of Business", key: "businessName", width: 25 },
            { header: "Owner", key: "ownerName", width: 25 },
            { header: "Type", key: "businessType", width: 20 },
            { header: "Contact", key: "contactNumber", width: 15 },
            { header: "Address", key: "address", width: 30 }
        ];

        // Format data
        const formattedData = businesses.map(business => ({
            businessName: business.businessName || "No Record",
            ownerName: business.ownerName || "No Record",
            businessType: business.businessType || "No Record",
            contactNumber: business.contactNumber || "No Record",
            address: `${business.houseNo || "No Record"}, Purok ${business.purok || "No Record"}`
        }));

        worksheet.addRows(formattedData);

        // Generate the file buffer
        const buffer = await workbook.xlsx.writeBuffer();

        // Set headers for file download
        res.setHeader("Content-Disposition", "attachment; filename=businesses.xlsx");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

        // Send the buffer to the client
        res.send(Buffer.from(buffer));

    } catch (error) {
        console.error("❌ Error exporting businesses:", error);
        res.status(500).json({ message: "Error exporting business data." });
    }
});
app.get("/export-hotline", isLogin, (req, res) => {
    res.render("converting", { title: "", layout: "layout", activePage: ""} );
});
app.get("/download-hotline", async (req, res) => {
    try {
        const hotlines = await db.collection("hotline").find().toArray();

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet("Hotlines");

        // Define only needed columns
        worksheet.columns = [
            { header: "Office", key: "office", width: 25 },
            { header: "Contact 1", key: "phone1", width: 15 },
            { header: "Contact 2", key: "phone2", width: 15 },
            { header: "Contact 3", key: "phone3", width: 15 }
        ];

        // Format data without email and web
        const formattedData = hotlines.map(hotline => ({
            office: hotline.office || "No Record",
            phone1: hotline.phone1 || "No Record",
            phone2: hotline.phone2 || "No Record",
            phone3: hotline.phone3 || "No Record"
        }));

        worksheet.addRows(formattedData);

        const buffer = await workbook.xlsx.writeBuffer();

        res.setHeader("Content-Disposition", "attachment; filename=hotlines.xlsx");
        res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

        res.send(Buffer.from(buffer));
    } catch (error) {
        console.error("❌ Error exporting hotlines:", error);
        res.status(500).json({ message: "Error exporting hotline data." });
    }
});

app.get("/hsh", isLogin, async (req, res) => {
    try {
        const householdsCollection = db.collection("household");
        const familiesCollection = db.collection("family");
        const residentsCollection = db.collection("resident");
        const { ObjectId } = require("mongodb");

        // Fetch all households where archive is "0" or 0, ordered by purok
        const households = await householdsCollection
            .find({ archive: { $in: ["0", 0] } })
            .sort({ purok: 1 })
            .toArray();

        let totalHouseholds = households.length;
        let totalFamilies = 0;
        let totalMembers = 0;

        // Fetch all families and residents at once
        const families = await familiesCollection.find({ archive: { $in: ["0", 0] } }).toArray();
        const residents = await residentsCollection.find({ archive: { $in: ["0", 0] } }).toArray();

        // Group families by householdId
        const familiesByHousehold = {};
        families.forEach(family => {
            if (!familiesByHousehold[family.householdId]) {
                familiesByHousehold[family.householdId] = [];
            }
            familiesByHousehold[family.householdId].push(family);
        });

        // Group residents by familyId
        const residentsByFamily = {};
        residents.forEach(resident => {
            if (!residentsByFamily[resident.familyId]) {
                residentsByFamily[resident.familyId] = [];
            }
            residentsByFamily[resident.familyId].push(resident);
        });

        // Process each household
        for (let household of households) {
            const householdId = household._id.toString();
            const familyList = familiesByHousehold[householdId] || [];
            const familyIds = familyList.map(fam => fam._id.toString());

            const residentCount = familyIds.reduce((count, famId) => count + (residentsByFamily[famId]?.length || 0), 0);

            household.totalFamilies = familyList.length;
            household.totalResidents = residentCount;

            totalFamilies += familyList.length;
            totalMembers += residentCount;
        }

        // Calculate averages
        const avgFamilies = totalHouseholds ? (totalFamilies / totalHouseholds).toFixed(1) : 0;
        const avgMembers = totalHouseholds ? (totalMembers / totalHouseholds).toFixed(1) : 0;

        // 🚀 **New Logic to Update Family Poverty Status**
        for (let family of families) {
            if (!family._id) continue; // Skip if _id is missing
            const familyIdStr = family._id.toString();
            const familyResidents = residentsByFamily[familyIdStr] || [];

            let totalIncome = familyResidents.reduce((sum, res) => sum + (Number(res.monthlyIncome) || 0), 0);
            let familySize = familyResidents.length;

            let povertyStatus = "Non-Indigent";
            if (familySize >= 1 && familySize <= 2) {
                if (totalIncome < 7500) povertyStatus = "Indigent";
                else if (totalIncome <= 10000) povertyStatus = "Low Income";
            } else if (familySize >= 3 && familySize <= 4) {
                if (totalIncome < 10000) povertyStatus = "Indigent";
                else if (totalIncome <= 13000) povertyStatus = "Low Income";
            } else if (familySize >= 5 && familySize <= 6) {
                if (totalIncome < 12500) povertyStatus = "Indigent";
                else if (totalIncome <= 15000) povertyStatus = "Low Income";
            } else if (familySize >= 7 && familySize <= 8) {
                if (totalIncome < 15000) povertyStatus = "Indigent";
                else if (totalIncome <= 18000) povertyStatus = "Low Income";
            } else if (familySize >= 9) {
                if (totalIncome < 17000) povertyStatus = "Indigent";
                else if (totalIncome <= 20000) povertyStatus = "Low Income";
            }

            await familiesCollection.updateOne(
                { _id: family._id },
                { $set: { familyIncome: totalIncome, poverty: povertyStatus } }
            );
        }

        // Render the view with processed data
        res.render("hsh", {
            layout: "layout",
            title: "Households",
            activePage: "hsh",
            households, // Pass households with totalFamilies and totalResidents data
            totalHouseholds,
            avgFamilies,
            avgMembers,
            titlePage: "Barangay Valdefuente"
        });
    } catch (err) {
        console.error("Error fetching households:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/hshD", isLogin, async (req, res) => {
    try {
        const householdsCollection = db.collection("household");
        const familiesCollection = db.collection("family");
        const residentsCollection = db.collection("resident");
        const { ObjectId } = require("mongodb");

        // Fetch households specifically for "Dike" purok and not archived
        const households = await householdsCollection
            .find({
                archive: { $in: ["0", 0] },
                purok: "Dike"
            })
            .sort({ purok: 1, houseNo: 1 })
            .toArray();

        // Extract the IDs of these "Dike" households for subsequent queries
        const dikeHouseholdObjectIds = households.map(h => h._id);

        // --- NEW LINE ADDED HERE ---
        // Convert the ObjectIds to strings for comparison if householdId in other collections is stored as string
        const dikeHouseholdStringIds = dikeHouseholdObjectIds.map(id => id.toString());
        // --- END NEW LINE ---


        // Fetch families that are not archived AND belong to the "Dike" households
        const families = await familiesCollection.find({
            archive: { $in: ["0", 0] },
            householdId: { $in: dikeHouseholdStringIds } // Use the STRING IDs here
        }).toArray();

        // Fetch residents that are not archived AND belong to the "Dike" households
        const residents = await residentsCollection.find({
            archive: { $in: ["0", 0] },
            householdId: { $in: dikeHouseholdStringIds } // Use the STRING IDs here
        }).toArray();

        // Initialize counters based on the filtered data
        let totalHouseholds = households.length;
        let totalFamilies = 0;
        let totalMembers = 0;

        // Group families by householdId
        const familiesByHousehold = {};
        families.forEach(family => {
            // Ensure family.householdId is converted to string for consistent map keys
            if (!familiesByHousehold[family.householdId.toString()]) {
                familiesByHousehold[family.householdId.toString()] = [];
            }
            familiesByHousehold[family.householdId.toString()].push(family);
        });

        // Group residents by familyId
        const residentsByFamily = {};
        residents.forEach(resident => {
            // Ensure resident.familyId is converted to string for consistent map keys
            if (!residentsByFamily[resident.familyId.toString()]) {
                residentsByFamily[resident.familyId.toString()] = [];
            }
            residentsByFamily[resident.familyId.toString()].push(resident);
        });

        // Process each household (now already filtered for "Dike" purok)
        for (let household of households) {
            const householdId = household._id.toString(); // Already a string
            const familyList = familiesByHousehold[householdId] || [];
            const familyIds = familyList.map(fam => fam._id.toString()); // Ensure _id is string here too

            const residentCount = familyIds.reduce((count, famId) => count + (residentsByFamily[famId]?.length || 0), 0);

            household.totalFamilies = familyList.length;
            household.totalResidents = residentCount;

            totalFamilies += familyList.length;
            totalMembers += residentCount;
        }

        // Calculate averages
        const avgFamilies = totalHouseholds ? (totalFamilies / totalHouseholds).toFixed(1) : 0;
        const avgMembers = totalHouseholds ? (totalMembers / totalHouseholds).toFixed(1) : 0;

        // Logic to Update Family Poverty Status
        for (let family of families) {
            if (!family._id) continue;
            const familyIdStr = family._id.toString();
            const familyResidents = residentsByFamily[familyIdStr] || [];

            let totalIncome = familyResidents.reduce((sum, res) => sum + (Number(res.monthlyIncome) || 0), 0);
            let familySize = familyResidents.length;

            let povertyStatus = "Non-Indigent";
            if (familySize >= 1 && familySize <= 2) {
                if (totalIncome < 7500) povertyStatus = "Indigent";
                else if (totalIncome <= 10000) povertyStatus = "Low Income";
            } else if (familySize >= 3 && familySize <= 4) {
                if (totalIncome < 10000) povertyStatus = "Indigent";
                else if (totalIncome <= 13000) povertyStatus = "Low Income";
            } else if (familySize >= 5 && familySize <= 6) {
                if (totalIncome < 12500) povertyStatus = "Indigent";
                else if (totalIncome <= 15000) povertyStatus = "Low Income";
            } else if (familySize >= 7 && familySize <= 8) {
                if (totalIncome < 15000) povertyStatus = "Indigent";
                else if (totalIncome <= 18000) povertyStatus = "Low Income";
            } else if (familySize >= 9) {
                if (totalIncome < 17000) povertyStatus = "Indigent";
                else if (totalIncome <= 20000) povertyStatus = "Low Income";
            }

            await familiesCollection.updateOne(
                { _id: family._id },
                { $set: { familyIncome: totalIncome, poverty: povertyStatus } }
            );
        }

        res.render("hsh", {
            layout: "layout",
            title: "Households",
            activePage: "hsh",
            households,
            totalHouseholds,
            avgFamilies,
            avgMembers,
            titlePage: "Dike Street"
        });
    } catch (err) {
        console.error("Error fetching households:", err.message);
        res.status(500).send("Internal Server Error! Please try again.");
    }
});

app.get("/hshS", isLogin, async (req, res) => {
    try {
        const householdsCollection = db.collection("household");
        const familiesCollection = db.collection("family");
        const residentsCollection = db.collection("resident");
        const { ObjectId } = require("mongodb");

        // Fetch households specifically for "Dike" purok and not archived
        const households = await householdsCollection
            .find({
                archive: { $in: ["0", 0] },
                purok: "Shortcut"
            })
            .sort({ purok: 1, houseNo: 1 })
            .toArray();

        // Extract the IDs of these "Dike" households for subsequent queries
        const dikeHouseholdObjectIds = households.map(h => h._id);

        // --- NEW LINE ADDED HERE ---
        // Convert the ObjectIds to strings for comparison if householdId in other collections is stored as string
        const dikeHouseholdStringIds = dikeHouseholdObjectIds.map(id => id.toString());
        // --- END NEW LINE ---


        // Fetch families that are not archived AND belong to the "Dike" households
        const families = await familiesCollection.find({
            archive: { $in: ["0", 0] },
            householdId: { $in: dikeHouseholdStringIds } // Use the STRING IDs here
        }).toArray();

        // Fetch residents that are not archived AND belong to the "Dike" households
        const residents = await residentsCollection.find({
            archive: { $in: ["0", 0] },
            householdId: { $in: dikeHouseholdStringIds } // Use the STRING IDs here
        }).toArray();

        // Initialize counters based on the filtered data
        let totalHouseholds = households.length;
        let totalFamilies = 0;
        let totalMembers = 0;

        // Group families by householdId
        const familiesByHousehold = {};
        families.forEach(family => {
            // Ensure family.householdId is converted to string for consistent map keys
            if (!familiesByHousehold[family.householdId.toString()]) {
                familiesByHousehold[family.householdId.toString()] = [];
            }
            familiesByHousehold[family.householdId.toString()].push(family);
        });

        // Group residents by familyId
        const residentsByFamily = {};
        residents.forEach(resident => {
            // Ensure resident.familyId is converted to string for consistent map keys
            if (!residentsByFamily[resident.familyId.toString()]) {
                residentsByFamily[resident.familyId.toString()] = [];
            }
            residentsByFamily[resident.familyId.toString()].push(resident);
        });

        // Process each household (now already filtered for "Dike" purok)
        for (let household of households) {
            const householdId = household._id.toString(); // Already a string
            const familyList = familiesByHousehold[householdId] || [];
            const familyIds = familyList.map(fam => fam._id.toString()); // Ensure _id is string here too

            const residentCount = familyIds.reduce((count, famId) => count + (residentsByFamily[famId]?.length || 0), 0);

            household.totalFamilies = familyList.length;
            household.totalResidents = residentCount;

            totalFamilies += familyList.length;
            totalMembers += residentCount;
        }

        // Calculate averages
        const avgFamilies = totalHouseholds ? (totalFamilies / totalHouseholds).toFixed(1) : 0;
        const avgMembers = totalHouseholds ? (totalMembers / totalHouseholds).toFixed(1) : 0;

        // Logic to Update Family Poverty Status
        for (let family of families) {
            if (!family._id) continue;
            const familyIdStr = family._id.toString();
            const familyResidents = residentsByFamily[familyIdStr] || [];

            let totalIncome = familyResidents.reduce((sum, res) => sum + (Number(res.monthlyIncome) || 0), 0);
            let familySize = familyResidents.length;

            let povertyStatus = "Non-Indigent";
            if (familySize >= 1 && familySize <= 2) {
                if (totalIncome < 7500) povertyStatus = "Indigent";
                else if (totalIncome <= 10000) povertyStatus = "Low Income";
            } else if (familySize >= 3 && familySize <= 4) {
                if (totalIncome < 10000) povertyStatus = "Indigent";
                else if (totalIncome <= 13000) povertyStatus = "Low Income";
            } else if (familySize >= 5 && familySize <= 6) {
                if (totalIncome < 12500) povertyStatus = "Indigent";
                else if (totalIncome <= 15000) povertyStatus = "Low Income";
            } else if (familySize >= 7 && familySize <= 8) {
                if (totalIncome < 15000) povertyStatus = "Indigent";
                else if (totalIncome <= 18000) povertyStatus = "Low Income";
            } else if (familySize >= 9) {
                if (totalIncome < 17000) povertyStatus = "Indigent";
                else if (totalIncome <= 20000) povertyStatus = "Low Income";
            }

            await familiesCollection.updateOne(
                { _id: family._id },
                { $set: { familyIncome: totalIncome, poverty: povertyStatus } }
            );
        }

        res.render("hsh", {
            layout: "layout",
            title: "Households",
            activePage: "hsh",
            households,
            totalHouseholds,
            avgFamilies,
            avgMembers,
            titlePage: "Shortcut Street"
        });
    } catch (err) {
        console.error("Error fetching households:", err.message);
        res.status(500).send("Internal Server Error! Please try again.");
    }
});

app.get("/hshC", isLogin, async (req, res) => {
    try {
        const householdsCollection = db.collection("household");
        const familiesCollection = db.collection("family");
        const residentsCollection = db.collection("resident");
        const { ObjectId } = require("mongodb");

        // Fetch households specifically for "Dike" purok and not archived
        const households = await householdsCollection
            .find({
                archive: { $in: ["0", 0] },
                purok: "Cantarilla"
            })
            .sort({ purok: 1, houseNo: 1 })
            .toArray();

        // Extract the IDs of these "Dike" households for subsequent queries
        const dikeHouseholdObjectIds = households.map(h => h._id);

        // --- NEW LINE ADDED HERE ---
        // Convert the ObjectIds to strings for comparison if householdId in other collections is stored as string
        const dikeHouseholdStringIds = dikeHouseholdObjectIds.map(id => id.toString());
        // --- END NEW LINE ---


        // Fetch families that are not archived AND belong to the "Dike" households
        const families = await familiesCollection.find({
            archive: { $in: ["0", 0] },
            householdId: { $in: dikeHouseholdStringIds } // Use the STRING IDs here
        }).toArray();

        // Fetch residents that are not archived AND belong to the "Dike" households
        const residents = await residentsCollection.find({
            archive: { $in: ["0", 0] },
            householdId: { $in: dikeHouseholdStringIds } // Use the STRING IDs here
        }).toArray();

        // Initialize counters based on the filtered data
        let totalHouseholds = households.length;
        let totalFamilies = 0;
        let totalMembers = 0;

        // Group families by householdId
        const familiesByHousehold = {};
        families.forEach(family => {
            // Ensure family.householdId is converted to string for consistent map keys
            if (!familiesByHousehold[family.householdId.toString()]) {
                familiesByHousehold[family.householdId.toString()] = [];
            }
            familiesByHousehold[family.householdId.toString()].push(family);
        });

        // Group residents by familyId
        const residentsByFamily = {};
        residents.forEach(resident => {
            // Ensure resident.familyId is converted to string for consistent map keys
            if (!residentsByFamily[resident.familyId.toString()]) {
                residentsByFamily[resident.familyId.toString()] = [];
            }
            residentsByFamily[resident.familyId.toString()].push(resident);
        });

        // Process each household (now already filtered for "Dike" purok)
        for (let household of households) {
            const householdId = household._id.toString(); // Already a string
            const familyList = familiesByHousehold[householdId] || [];
            const familyIds = familyList.map(fam => fam._id.toString()); // Ensure _id is string here too

            const residentCount = familyIds.reduce((count, famId) => count + (residentsByFamily[famId]?.length || 0), 0);

            household.totalFamilies = familyList.length;
            household.totalResidents = residentCount;

            totalFamilies += familyList.length;
            totalMembers += residentCount;
        }

        // Calculate averages
        const avgFamilies = totalHouseholds ? (totalFamilies / totalHouseholds).toFixed(1) : 0;
        const avgMembers = totalHouseholds ? (totalMembers / totalHouseholds).toFixed(1) : 0;

        // Logic to Update Family Poverty Status
        for (let family of families) {
            if (!family._id) continue;
            const familyIdStr = family._id.toString();
            const familyResidents = residentsByFamily[familyIdStr] || [];

            let totalIncome = familyResidents.reduce((sum, res) => sum + (Number(res.monthlyIncome) || 0), 0);
            let familySize = familyResidents.length;

            let povertyStatus = "Non-Indigent";
            if (familySize >= 1 && familySize <= 2) {
                if (totalIncome < 7500) povertyStatus = "Indigent";
                else if (totalIncome <= 10000) povertyStatus = "Low Income";
            } else if (familySize >= 3 && familySize <= 4) {
                if (totalIncome < 10000) povertyStatus = "Indigent";
                else if (totalIncome <= 13000) povertyStatus = "Low Income";
            } else if (familySize >= 5 && familySize <= 6) {
                if (totalIncome < 12500) povertyStatus = "Indigent";
                else if (totalIncome <= 15000) povertyStatus = "Low Income";
            } else if (familySize >= 7 && familySize <= 8) {
                if (totalIncome < 15000) povertyStatus = "Indigent";
                else if (totalIncome <= 18000) povertyStatus = "Low Income";
            } else if (familySize >= 9) {
                if (totalIncome < 17000) povertyStatus = "Indigent";
                else if (totalIncome <= 20000) povertyStatus = "Low Income";
            }

            await familiesCollection.updateOne(
                { _id: family._id },
                { $set: { familyIncome: totalIncome, poverty: povertyStatus } }
            );
        }

        res.render("hsh", {
            layout: "layout",
            title: "Households",
            activePage: "hsh",
            households,
            totalHouseholds,
            avgFamilies,
            avgMembers,
            titlePage: "Cantarilla Street"
        });
    } catch (err) {
        console.error("Error fetching households:", err.message);
        res.status(500).send("Internal Server Error! Please try again.");
    }
});

app.get("/hshB", isLogin, async (req, res) => {
    try {
        const householdsCollection = db.collection("household");
        const familiesCollection = db.collection("family");
        const residentsCollection = db.collection("resident");
        const { ObjectId } = require("mongodb");

        // Fetch households specifically for "Dike" purok and not archived
        const households = await householdsCollection
            .find({
                archive: { $in: ["0", 0] },
                purok: "Bagong Daan"
            })
            .sort({ purok: 1, houseNo: 1 })
            .toArray();

        // Extract the IDs of these "Dike" households for subsequent queries
        const dikeHouseholdObjectIds = households.map(h => h._id);

        // --- NEW LINE ADDED HERE ---
        // Convert the ObjectIds to strings for comparison if householdId in other collections is stored as string
        const dikeHouseholdStringIds = dikeHouseholdObjectIds.map(id => id.toString());
        // --- END NEW LINE ---


        // Fetch families that are not archived AND belong to the "Dike" households
        const families = await familiesCollection.find({
            archive: { $in: ["0", 0] },
            householdId: { $in: dikeHouseholdStringIds } // Use the STRING IDs here
        }).toArray();

        // Fetch residents that are not archived AND belong to the "Dike" households
        const residents = await residentsCollection.find({
            archive: { $in: ["0", 0] },
            householdId: { $in: dikeHouseholdStringIds } // Use the STRING IDs here
        }).toArray();

        // Initialize counters based on the filtered data
        let totalHouseholds = households.length;
        let totalFamilies = 0;
        let totalMembers = 0;

        // Group families by householdId
        const familiesByHousehold = {};
        families.forEach(family => {
            // Ensure family.householdId is converted to string for consistent map keys
            if (!familiesByHousehold[family.householdId.toString()]) {
                familiesByHousehold[family.householdId.toString()] = [];
            }
            familiesByHousehold[family.householdId.toString()].push(family);
        });

        // Group residents by familyId
        const residentsByFamily = {};
        residents.forEach(resident => {
            // Ensure resident.familyId is converted to string for consistent map keys
            if (!residentsByFamily[resident.familyId.toString()]) {
                residentsByFamily[resident.familyId.toString()] = [];
            }
            residentsByFamily[resident.familyId.toString()].push(resident);
        });

        // Process each household (now already filtered for "Dike" purok)
        for (let household of households) {
            const householdId = household._id.toString(); // Already a string
            const familyList = familiesByHousehold[householdId] || [];
            const familyIds = familyList.map(fam => fam._id.toString()); // Ensure _id is string here too

            const residentCount = familyIds.reduce((count, famId) => count + (residentsByFamily[famId]?.length || 0), 0);

            household.totalFamilies = familyList.length;
            household.totalResidents = residentCount;

            totalFamilies += familyList.length;
            totalMembers += residentCount;
        }

        // Calculate averages
        const avgFamilies = totalHouseholds ? (totalFamilies / totalHouseholds).toFixed(1) : 0;
        const avgMembers = totalHouseholds ? (totalMembers / totalHouseholds).toFixed(1) : 0;

        // Logic to Update Family Poverty Status
        for (let family of families) {
            if (!family._id) continue;
            const familyIdStr = family._id.toString();
            const familyResidents = residentsByFamily[familyIdStr] || [];

            let totalIncome = familyResidents.reduce((sum, res) => sum + (Number(res.monthlyIncome) || 0), 0);
            let familySize = familyResidents.length;

            let povertyStatus = "Non-Indigent";
            if (familySize >= 1 && familySize <= 2) {
                if (totalIncome < 7500) povertyStatus = "Indigent";
                else if (totalIncome <= 10000) povertyStatus = "Low Income";
            } else if (familySize >= 3 && familySize <= 4) {
                if (totalIncome < 10000) povertyStatus = "Indigent";
                else if (totalIncome <= 13000) povertyStatus = "Low Income";
            } else if (familySize >= 5 && familySize <= 6) {
                if (totalIncome < 12500) povertyStatus = "Indigent";
                else if (totalIncome <= 15000) povertyStatus = "Low Income";
            } else if (familySize >= 7 && familySize <= 8) {
                if (totalIncome < 15000) povertyStatus = "Indigent";
                else if (totalIncome <= 18000) povertyStatus = "Low Income";
            } else if (familySize >= 9) {
                if (totalIncome < 17000) povertyStatus = "Indigent";
                else if (totalIncome <= 20000) povertyStatus = "Low Income";
            }

            await familiesCollection.updateOne(
                { _id: family._id },
                { $set: { familyIncome: totalIncome, poverty: povertyStatus } }
            );
        }

        res.render("hsh", {
            layout: "layout",
            title: "Households",
            activePage: "hsh",
            households,
            totalHouseholds,
            avgFamilies,
            avgMembers,
            titlePage: "Bagong Daan Street"
        });
    } catch (err) {
        console.error("Error fetching households:", err.message);
        res.status(500).send("Internal Server Error! Please try again.");
    }
});

app.get("/hshP", isLogin, async (req, res) => {
    try {
        const householdsCollection = db.collection("household");
        const familiesCollection = db.collection("family");
        const residentsCollection = db.collection("resident");
        const { ObjectId } = require("mongodb");

        // Fetch households specifically for "Dike" purok and not archived
        const households = await householdsCollection
            .find({
                archive: { $in: ["0", 0] },
                purok: "Perigola"
            })
            .sort({ purok: 1, houseNo: 1 })
            .toArray();

        // Extract the IDs of these "Dike" households for subsequent queries
        const dikeHouseholdObjectIds = households.map(h => h._id);

        // --- NEW LINE ADDED HERE ---
        // Convert the ObjectIds to strings for comparison if householdId in other collections is stored as string
        const dikeHouseholdStringIds = dikeHouseholdObjectIds.map(id => id.toString());
        // --- END NEW LINE ---


        // Fetch families that are not archived AND belong to the "Dike" households
        const families = await familiesCollection.find({
            archive: { $in: ["0", 0] },
            householdId: { $in: dikeHouseholdStringIds } // Use the STRING IDs here
        }).toArray();

        // Fetch residents that are not archived AND belong to the "Dike" households
        const residents = await residentsCollection.find({
            archive: { $in: ["0", 0] },
            householdId: { $in: dikeHouseholdStringIds } // Use the STRING IDs here
        }).toArray();

        // Initialize counters based on the filtered data
        let totalHouseholds = households.length;
        let totalFamilies = 0;
        let totalMembers = 0;

        // Group families by householdId
        const familiesByHousehold = {};
        families.forEach(family => {
            // Ensure family.householdId is converted to string for consistent map keys
            if (!familiesByHousehold[family.householdId.toString()]) {
                familiesByHousehold[family.householdId.toString()] = [];
            }
            familiesByHousehold[family.householdId.toString()].push(family);
        });

        // Group residents by familyId
        const residentsByFamily = {};
        residents.forEach(resident => {
            // Ensure resident.familyId is converted to string for consistent map keys
            if (!residentsByFamily[resident.familyId.toString()]) {
                residentsByFamily[resident.familyId.toString()] = [];
            }
            residentsByFamily[resident.familyId.toString()].push(resident);
        });

        // Process each household (now already filtered for "Dike" purok)
        for (let household of households) {
            const householdId = household._id.toString(); // Already a string
            const familyList = familiesByHousehold[householdId] || [];
            const familyIds = familyList.map(fam => fam._id.toString()); // Ensure _id is string here too

            const residentCount = familyIds.reduce((count, famId) => count + (residentsByFamily[famId]?.length || 0), 0);

            household.totalFamilies = familyList.length;
            household.totalResidents = residentCount;

            totalFamilies += familyList.length;
            totalMembers += residentCount;
        }

        // Calculate averages
        const avgFamilies = totalHouseholds ? (totalFamilies / totalHouseholds).toFixed(1) : 0;
        const avgMembers = totalHouseholds ? (totalMembers / totalHouseholds).toFixed(1) : 0;

        // Logic to Update Family Poverty Status
        for (let family of families) {
            if (!family._id) continue;
            const familyIdStr = family._id.toString();
            const familyResidents = residentsByFamily[familyIdStr] || [];

            let totalIncome = familyResidents.reduce((sum, res) => sum + (Number(res.monthlyIncome) || 0), 0);
            let familySize = familyResidents.length;

            let povertyStatus = "Non-Indigent";
            if (familySize >= 1 && familySize <= 2) {
                if (totalIncome < 7500) povertyStatus = "Indigent";
                else if (totalIncome <= 10000) povertyStatus = "Low Income";
            } else if (familySize >= 3 && familySize <= 4) {
                if (totalIncome < 10000) povertyStatus = "Indigent";
                else if (totalIncome <= 13000) povertyStatus = "Low Income";
            } else if (familySize >= 5 && familySize <= 6) {
                if (totalIncome < 12500) povertyStatus = "Indigent";
                else if (totalIncome <= 15000) povertyStatus = "Low Income";
            } else if (familySize >= 7 && familySize <= 8) {
                if (totalIncome < 15000) povertyStatus = "Indigent";
                else if (totalIncome <= 18000) povertyStatus = "Low Income";
            } else if (familySize >= 9) {
                if (totalIncome < 17000) povertyStatus = "Indigent";
                else if (totalIncome <= 20000) povertyStatus = "Low Income";
            }

            await familiesCollection.updateOne(
                { _id: family._id },
                { $set: { familyIncome: totalIncome, poverty: povertyStatus } }
            );
        }

        res.render("hsh", {
            layout: "layout",
            title: "Households",
            activePage: "hsh",
            households,
            totalHouseholds,
            avgFamilies,
            avgMembers,
            titlePage: "Perigola Street"
        });
    } catch (err) {
        console.error("Error fetching households:", err.message);
        res.status(500).send("Internal Server Error! Please try again.");
    }
});

app.get("/hshH", isLogin, async (req, res) => {
    try {
        const householdsCollection = db.collection("household");
        const familiesCollection = db.collection("family");
        const residentsCollection = db.collection("resident");
        const { ObjectId } = require("mongodb");

        // Fetch households specifically for "Dike" purok and not archived
        const households = await householdsCollection
            .find({
                archive: { $in: ["0", 0] },
                purok: "Maharlika Highway"
            })
            .sort({ purok: 1, houseNo: 1 })
            .toArray();

        // Extract the IDs of these "Dike" households for subsequent queries
        const dikeHouseholdObjectIds = households.map(h => h._id);

        // --- NEW LINE ADDED HERE ---
        // Convert the ObjectIds to strings for comparison if householdId in other collections is stored as string
        const dikeHouseholdStringIds = dikeHouseholdObjectIds.map(id => id.toString());
        // --- END NEW LINE ---


        // Fetch families that are not archived AND belong to the "Dike" households
        const families = await familiesCollection.find({
            archive: { $in: ["0", 0] },
            householdId: { $in: dikeHouseholdStringIds } // Use the STRING IDs here
        }).toArray();

        // Fetch residents that are not archived AND belong to the "Dike" households
        const residents = await residentsCollection.find({
            archive: { $in: ["0", 0] },
            householdId: { $in: dikeHouseholdStringIds } // Use the STRING IDs here
        }).toArray();

        // Initialize counters based on the filtered data
        let totalHouseholds = households.length;
        let totalFamilies = 0;
        let totalMembers = 0;

        // Group families by householdId
        const familiesByHousehold = {};
        families.forEach(family => {
            // Ensure family.householdId is converted to string for consistent map keys
            if (!familiesByHousehold[family.householdId.toString()]) {
                familiesByHousehold[family.householdId.toString()] = [];
            }
            familiesByHousehold[family.householdId.toString()].push(family);
        });

        // Group residents by familyId
        const residentsByFamily = {};
        residents.forEach(resident => {
            // Ensure resident.familyId is converted to string for consistent map keys
            if (!residentsByFamily[resident.familyId.toString()]) {
                residentsByFamily[resident.familyId.toString()] = [];
            }
            residentsByFamily[resident.familyId.toString()].push(resident);
        });

        // Process each household (now already filtered for "Dike" purok)
        for (let household of households) {
            const householdId = household._id.toString(); // Already a string
            const familyList = familiesByHousehold[householdId] || [];
            const familyIds = familyList.map(fam => fam._id.toString()); // Ensure _id is string here too

            const residentCount = familyIds.reduce((count, famId) => count + (residentsByFamily[famId]?.length || 0), 0);

            household.totalFamilies = familyList.length;
            household.totalResidents = residentCount;

            totalFamilies += familyList.length;
            totalMembers += residentCount;
        }

        // Calculate averages
        const avgFamilies = totalHouseholds ? (totalFamilies / totalHouseholds).toFixed(1) : 0;
        const avgMembers = totalHouseholds ? (totalMembers / totalHouseholds).toFixed(1) : 0;

        // Logic to Update Family Poverty Status
        for (let family of families) {
            if (!family._id) continue;
            const familyIdStr = family._id.toString();
            const familyResidents = residentsByFamily[familyIdStr] || [];

            let totalIncome = familyResidents.reduce((sum, res) => sum + (Number(res.monthlyIncome) || 0), 0);
            let familySize = familyResidents.length;

            let povertyStatus = "Non-Indigent";
            if (familySize >= 1 && familySize <= 2) {
                if (totalIncome < 7500) povertyStatus = "Indigent";
                else if (totalIncome <= 10000) povertyStatus = "Low Income";
            } else if (familySize >= 3 && familySize <= 4) {
                if (totalIncome < 10000) povertyStatus = "Indigent";
                else if (totalIncome <= 13000) povertyStatus = "Low Income";
            } else if (familySize >= 5 && familySize <= 6) {
                if (totalIncome < 12500) povertyStatus = "Indigent";
                else if (totalIncome <= 15000) povertyStatus = "Low Income";
            } else if (familySize >= 7 && familySize <= 8) {
                if (totalIncome < 15000) povertyStatus = "Indigent";
                else if (totalIncome <= 18000) povertyStatus = "Low Income";
            } else if (familySize >= 9) {
                if (totalIncome < 17000) povertyStatus = "Indigent";
                else if (totalIncome <= 20000) povertyStatus = "Low Income";
            }

            await familiesCollection.updateOne(
                { _id: family._id },
                { $set: { familyIncome: totalIncome, poverty: povertyStatus } }
            );
        }

        res.render("hsh", {
            layout: "layout",
            title: "Households",
            activePage: "hsh",
            households,
            totalHouseholds,
            avgFamilies,
            avgMembers,
            titlePage: "Maharlika Highway"
        });
    } catch (err) {
        console.error("Error fetching households:", err.message);
        res.status(500).send("Internal Server Error! Please try again.");
    }
});


app.get("/household/:houseNo/:purok", isLogin, async (req, res) => {
    try {
        const { houseNo, purok } = req.params;

        // Fetch all residents in the same household
        const residents = await db.collection("resident").find({
            houseNo: houseNo,
            purok: purok,
            archive: { $ne: 1 }
        }).sort({ firstName: 1 }).toArray();

        res.render("hshView", {
            layout: "layout",
            title: `Household: ${houseNo}, ${purok}`,
            activePage: "rsd",
            residents: residents,
            houseNo: houseNo,
            purok: purok
        });
    } catch (err) {
        console.error("Error fetching household residents:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/fmlD", isLogin, async (req, res) => {
    try {
        // Fetch only non-archived households with purok = "Dike"
        const households = await db.collection("household")
            .find({ archive: { $in: [0, "0"] }, purok: "Dike" })
            .toArray();

        // Collect household IDs
        const householdIdsObj = households.map(h => h._id);           // ObjectIds
        const householdIdsStr = households.map(h => h._id.toString());
        const householdIdsMixed = [...householdIdsObj, ...householdIdsStr];

        const families = await db.collection("family").find({
            archive: { $in: [0, "0"] },
            householdId: { $in: householdIdsMixed }
        }).sort({ purok: 1 }).toArray();

        // Residents
        const residents = await db.collection("resident").find({
            archive: { $in: [0, "0"] },
            householdId: { $in: householdIdsMixed }
        }).sort({ purok: 1 }).toArray();

        // Create a map for quick household lookup
        const householdMap = Object.fromEntries(households.map(house => [
            house._id.toString(),
            { _id: house._id, houseNo: house.houseNo || "--", purok: house.purok }
        ]));

        // Initialize total counts
        let totalMembersCount = 0;
        let totalIndigent = 0;
        let totalLowIncome = 0;
        let totalNonIndigent = 0;

        // Process families
        const familyList = families.map(family => {
            const householdInfo = householdMap[family.householdId?.toString()] || { houseNo: "--", purok: "--" };

            // Get ALL residents of the family (both head and members)
            const familyMembersList = residents.filter(resident =>
                resident.familyId?.toString() === family._id.toString()
            );

            // Find the family head
            const familyHead = familyMembersList.find(resident => resident.role === "Head");

            // Handle missing names
            const familyHeadName = familyHead
                ? [familyHead.firstName, familyHead.middleName, familyHead.lastName, familyHead.extName].filter(Boolean).join(" ")
                : "--";

            // Prepare list of members with full names
            const membersData = familyMembersList.map(member => ({
                ...member,
                fullName: [member.firstName, member.middleName, member.lastName, member.extName].filter(Boolean).join(" ")
            }));

            // Count members + poverty stats
            const totalMembers = familyMembersList.length;
            totalMembersCount += totalMembers;
            const povertyStatus = family.poverty || "--";
            if (povertyStatus === "Indigent") totalIndigent++;
            if (povertyStatus === "Low Income") totalLowIncome++;
            if (povertyStatus === "Non-Indigent") totalNonIndigent++;

            return {
                _id: family._id,
        householdId: householdInfo._id,
                houseNo: householdInfo.houseNo,
                purok: householdInfo.purok,
                familyHead: familyHeadName,
                totalMembers,
                poverty: povertyStatus,
                members: membersData
            };
        });

        // Compute statistics
        const totalFamilies = families.length;
        const avgMembersPerFamily = totalFamilies > 0 ? (totalMembersCount / totalFamilies).toFixed(2) : 0;

        res.render("fml", {
            layout: "layout",
            title: "Families",
            activePage: "fml",
            families: familyList,
            totalFamilies,
            avgMembersPerFamily,
            totalIndigent,
            totalLowIncome,
            totalNonIndigent,
            titlePage: "Families from Purok Dike"
        });

    } catch (err) {
        console.error("Error fetching family data:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});


app.get("/fmlC", isLogin, async (req, res) => {
    try {
        // Fetch only non-archived households with purok = "Dike"
        const households = await db.collection("household")
            .find({ archive: { $in: [0, "0"] }, purok: "Cantarilla" })
            .toArray();

        // Collect household IDs
        const householdIdsObj = households.map(h => h._id);           // ObjectIds
        const householdIdsStr = households.map(h => h._id.toString());
        const householdIdsMixed = [...householdIdsObj, ...householdIdsStr];

        const families = await db.collection("family").find({
            archive: { $in: [0, "0"] },
            householdId: { $in: householdIdsMixed }
        }).sort({ purok: 1 }).toArray();

        // Residents
        const residents = await db.collection("resident").find({
            archive: { $in: [0, "0"] },
            householdId: { $in: householdIdsMixed }
        }).sort({ purok: 1 }).toArray();

        // Create a map for quick household lookup
        const householdMap = Object.fromEntries(households.map(house => [
            house._id.toString(),
            { _id: house._id, houseNo: house.houseNo || "--", purok: house.purok }
        ]));

        // Initialize total counts
        let totalMembersCount = 0;
        let totalIndigent = 0;
        let totalLowIncome = 0;
        let totalNonIndigent = 0;

        // Process families
        const familyList = families.map(family => {
            const householdInfo = householdMap[family.householdId?.toString()] || { houseNo: "--", purok: "--" };

            // Get ALL residents of the family (both head and members)
            const familyMembersList = residents.filter(resident =>
                resident.familyId?.toString() === family._id.toString()
            );

            // Find the family head
            const familyHead = familyMembersList.find(resident => resident.role === "Head");

            // Handle missing names
            const familyHeadName = familyHead
                ? [familyHead.firstName, familyHead.middleName, familyHead.lastName, familyHead.extName].filter(Boolean).join(" ")
                : "--";

            // Prepare list of members with full names
            const membersData = familyMembersList.map(member => ({
                ...member,
                fullName: [member.firstName, member.middleName, member.lastName, member.extName].filter(Boolean).join(" ")
            }));

            // Count members + poverty stats
            const totalMembers = familyMembersList.length;
            totalMembersCount += totalMembers;
            const povertyStatus = family.poverty || "--";
            if (povertyStatus === "Indigent") totalIndigent++;
            if (povertyStatus === "Low Income") totalLowIncome++;
            if (povertyStatus === "Non-Indigent") totalNonIndigent++;

            return {
                _id: family._id,
        householdId: householdInfo._id,
                houseNo: householdInfo.houseNo,
                purok: householdInfo.purok,
                familyHead: familyHeadName,
                totalMembers,
                poverty: povertyStatus,
                members: membersData
            };
        });

        // Compute statistics
        const totalFamilies = families.length;
        const avgMembersPerFamily = totalFamilies > 0 ? (totalMembersCount / totalFamilies).toFixed(2) : 0;

        res.render("fml", {
            layout: "layout",
            title: "Families",
            activePage: "fml",
            families: familyList,
            totalFamilies,
            avgMembersPerFamily,
            totalIndigent,
            totalLowIncome,
            totalNonIndigent,
            titlePage: "Families from Purok Cantarilla"
        });

    } catch (err) {
        console.error("Error fetching family data:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/fmlB", isLogin, async (req, res) => {
    try {
        // Fetch only non-archived households with purok = "Dike"
        const households = await db.collection("household")
            .find({ archive: { $in: [0, "0"] }, purok: "Bagong Daan" })
            .toArray();

        // Collect household IDs
        const householdIdsObj = households.map(h => h._id);           // ObjectIds
        const householdIdsStr = households.map(h => h._id.toString());
        const householdIdsMixed = [...householdIdsObj, ...householdIdsStr];

        const families = await db.collection("family").find({
            archive: { $in: [0, "0"] },
            householdId: { $in: householdIdsMixed }
        }).sort({ purok: 1 }).toArray();

        // Residents
        const residents = await db.collection("resident").find({
            archive: { $in: [0, "0"] },
            householdId: { $in: householdIdsMixed }
        }).sort({ purok: 1 }).toArray();

        // Create a map for quick household lookup
        const householdMap = Object.fromEntries(households.map(house => [
            house._id.toString(),
            { _id: house._id, houseNo: house.houseNo || "--", purok: house.purok }
        ]));

        // Initialize total counts
        let totalMembersCount = 0;
        let totalIndigent = 0;
        let totalLowIncome = 0;
        let totalNonIndigent = 0;

        // Process families
        const familyList = families.map(family => {
            const householdInfo = householdMap[family.householdId?.toString()] || { houseNo: "--", purok: "--" };

            // Get ALL residents of the family (both head and members)
            const familyMembersList = residents.filter(resident =>
                resident.familyId?.toString() === family._id.toString()
            );

            // Find the family head
            const familyHead = familyMembersList.find(resident => resident.role === "Head");

            // Handle missing names
            const familyHeadName = familyHead
                ? [familyHead.firstName, familyHead.middleName, familyHead.lastName, familyHead.extName].filter(Boolean).join(" ")
                : "--";

            // Prepare list of members with full names
            const membersData = familyMembersList.map(member => ({
                ...member,
                fullName: [member.firstName, member.middleName, member.lastName, member.extName].filter(Boolean).join(" ")
            }));

            // Count members + poverty stats
            const totalMembers = familyMembersList.length;
            totalMembersCount += totalMembers;
            const povertyStatus = family.poverty || "--";
            if (povertyStatus === "Indigent") totalIndigent++;
            if (povertyStatus === "Low Income") totalLowIncome++;
            if (povertyStatus === "Non-Indigent") totalNonIndigent++;

            return {
                _id: family._id,
        householdId: householdInfo._id,
                houseNo: householdInfo.houseNo,
                purok: householdInfo.purok,
                familyHead: familyHeadName,
                totalMembers,
                poverty: povertyStatus,
                members: membersData
            };
        });

        // Compute statistics
        const totalFamilies = families.length;
        const avgMembersPerFamily = totalFamilies > 0 ? (totalMembersCount / totalFamilies).toFixed(2) : 0;

        res.render("fml", {
            layout: "layout",
            title: "Families",
            activePage: "fml",
            families: familyList,
            totalFamilies,
            avgMembersPerFamily,
            totalIndigent,
            totalLowIncome,
            totalNonIndigent,
            titlePage: "Families from Bagong Daan"
        });

    } catch (err) {
        console.error("Error fetching family data:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/fmlH", isLogin, async (req, res) => {
    try {
        // Fetch only non-archived households with purok = "Dike"
        const households = await db.collection("household")
            .find({ archive: { $in: [0, "0"] }, purok: "Maharlika Highway" })
            .toArray();

        // Collect household IDs
        const householdIdsObj = households.map(h => h._id);           // ObjectIds
        const householdIdsStr = households.map(h => h._id.toString());
        const householdIdsMixed = [...householdIdsObj, ...householdIdsStr];

        const families = await db.collection("family").find({
            archive: { $in: [0, "0"] },
            householdId: { $in: householdIdsMixed }
        }).sort({ purok: 1 }).toArray();

        // Residents
        const residents = await db.collection("resident").find({
            archive: { $in: [0, "0"] },
            householdId: { $in: householdIdsMixed }
        }).sort({ purok: 1 }).toArray();

        // Create a map for quick household lookup
        const householdMap = Object.fromEntries(households.map(house => [
            house._id.toString(),
            { _id: house._id, houseNo: house.houseNo || "--", purok: house.purok }
        ]));

        // Initialize total counts
        let totalMembersCount = 0;
        let totalIndigent = 0;
        let totalLowIncome = 0;
        let totalNonIndigent = 0;

        // Process families
        const familyList = families.map(family => {
            const householdInfo = householdMap[family.householdId?.toString()] || { houseNo: "--", purok: "--" };

            // Get ALL residents of the family (both head and members)
            const familyMembersList = residents.filter(resident =>
                resident.familyId?.toString() === family._id.toString()
            );

            // Find the family head
            const familyHead = familyMembersList.find(resident => resident.role === "Head");

            // Handle missing names
            const familyHeadName = familyHead
                ? [familyHead.firstName, familyHead.middleName, familyHead.lastName, familyHead.extName].filter(Boolean).join(" ")
                : "--";

            // Prepare list of members with full names
            const membersData = familyMembersList.map(member => ({
                ...member,
                fullName: [member.firstName, member.middleName, member.lastName, member.extName].filter(Boolean).join(" ")
            }));

            // Count members + poverty stats
            const totalMembers = familyMembersList.length;
            totalMembersCount += totalMembers;
            const povertyStatus = family.poverty || "--";
            if (povertyStatus === "Indigent") totalIndigent++;
            if (povertyStatus === "Low Income") totalLowIncome++;
            if (povertyStatus === "Non-Indigent") totalNonIndigent++;

            return {
                _id: family._id,
        householdId: householdInfo._id,
                houseNo: householdInfo.houseNo,
                purok: householdInfo.purok,
                familyHead: familyHeadName,
                totalMembers,
                poverty: povertyStatus,
                members: membersData
            };
        });

        // Compute statistics
        const totalFamilies = families.length;
        const avgMembersPerFamily = totalFamilies > 0 ? (totalMembersCount / totalFamilies).toFixed(2) : 0;

        res.render("fml", {
            layout: "layout",
            title: "Families",
            activePage: "fml",
            families: familyList,
            totalFamilies,
            avgMembersPerFamily,
            totalIndigent,
            totalLowIncome,
            totalNonIndigent,
            titlePage: "Families from Maharlika Highway"
        });

    } catch (err) {
        console.error("Error fetching family data:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/fmlP", isLogin, async (req, res) => {
    try {
        // Fetch only non-archived households with purok = "Dike"
        const households = await db.collection("household")
            .find({ archive: { $in: [0, "0"] }, purok: "Perigola" })
            .toArray();

        // Collect household IDs
        const householdIdsObj = households.map(h => h._id);           // ObjectIds
        const householdIdsStr = households.map(h => h._id.toString());
        const householdIdsMixed = [...householdIdsObj, ...householdIdsStr];

        const families = await db.collection("family").find({
            archive: { $in: [0, "0"] },
            householdId: { $in: householdIdsMixed }
        }).sort({ purok: 1 }).toArray();

        // Residents
        const residents = await db.collection("resident").find({
            archive: { $in: [0, "0"] },
            householdId: { $in: householdIdsMixed }
        }).sort({ purok: 1 }).toArray();

        // Create a map for quick household lookup
        const householdMap = Object.fromEntries(households.map(house => [
            house._id.toString(),
            { _id: house._id, houseNo: house.houseNo || "--", purok: house.purok }
        ]));

        // Initialize total counts
        let totalMembersCount = 0;
        let totalIndigent = 0;
        let totalLowIncome = 0;
        let totalNonIndigent = 0;

        // Process families
        const familyList = families.map(family => {
            const householdInfo = householdMap[family.householdId?.toString()] || { houseNo: "--", purok: "--" };

            // Get ALL residents of the family (both head and members)
            const familyMembersList = residents.filter(resident =>
                resident.familyId?.toString() === family._id.toString()
            );

            // Find the family head
            const familyHead = familyMembersList.find(resident => resident.role === "Head");

            // Handle missing names
            const familyHeadName = familyHead
                ? [familyHead.firstName, familyHead.middleName, familyHead.lastName, familyHead.extName].filter(Boolean).join(" ")
                : "--";

            // Prepare list of members with full names
            const membersData = familyMembersList.map(member => ({
                ...member,
                fullName: [member.firstName, member.middleName, member.lastName, member.extName].filter(Boolean).join(" ")
            }));

            // Count members + poverty stats
            const totalMembers = familyMembersList.length;
            totalMembersCount += totalMembers;
            const povertyStatus = family.poverty || "--";
            if (povertyStatus === "Indigent") totalIndigent++;
            if (povertyStatus === "Low Income") totalLowIncome++;
            if (povertyStatus === "Non-Indigent") totalNonIndigent++;

            return {
                _id: family._id,
        householdId: householdInfo._id,
                houseNo: householdInfo.houseNo,
                purok: householdInfo.purok,
                familyHead: familyHeadName,
                totalMembers,
                poverty: povertyStatus,
                members: membersData
            };
        });

        // Compute statistics
        const totalFamilies = families.length;
        const avgMembersPerFamily = totalFamilies > 0 ? (totalMembersCount / totalFamilies).toFixed(2) : 0;

        res.render("fml", {
            layout: "layout",
            title: "Families",
            activePage: "fml",
            families: familyList,
            totalFamilies,
            avgMembersPerFamily,
            totalIndigent,
            totalLowIncome,
            totalNonIndigent,
            titlePage: "Families from Purok Perigola"
        });

    } catch (err) {
        console.error("Error fetching family data:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/fmlS", isLogin, async (req, res) => {
    try {
        // Fetch only non-archived households with purok = "Dike"
        const households = await db.collection("household")
            .find({ archive: { $in: [0, "0"] }, purok: "Shortcut" })
            .toArray();

        // Collect household IDs
        const householdIdsObj = households.map(h => h._id);           // ObjectIds
        const householdIdsStr = households.map(h => h._id.toString());
        const householdIdsMixed = [...householdIdsObj, ...householdIdsStr];

        const families = await db.collection("family").find({
            archive: { $in: [0, "0"] },
            householdId: { $in: householdIdsMixed }
        }).sort({ purok: 1 }).toArray();

        // Residents
        const residents = await db.collection("resident").find({
            archive: { $in: [0, "0"] },
            householdId: { $in: householdIdsMixed }
        }).sort({ purok: 1 }).toArray();

        // Create a map for quick household lookup
        const householdMap = Object.fromEntries(households.map(house => [
            house._id.toString(),
            { _id: house._id, houseNo: house.houseNo || "--", purok: house.purok }
        ]));

        // Initialize total counts
        let totalMembersCount = 0;
        let totalIndigent = 0;
        let totalLowIncome = 0;
        let totalNonIndigent = 0;

        // Process families
        const familyList = families.map(family => {
            const householdInfo = householdMap[family.householdId?.toString()] || { houseNo: "--", purok: "--" };

            // Get ALL residents of the family (both head and members)
            const familyMembersList = residents.filter(resident =>
                resident.familyId?.toString() === family._id.toString()
            );

            // Find the family head
            const familyHead = familyMembersList.find(resident => resident.role === "Head");

            // Handle missing names
            const familyHeadName = familyHead
                ? [familyHead.firstName, familyHead.middleName, familyHead.lastName, familyHead.extName].filter(Boolean).join(" ")
                : "--";

            // Prepare list of members with full names
            const membersData = familyMembersList.map(member => ({
                ...member,
                fullName: [member.firstName, member.middleName, member.lastName, member.extName].filter(Boolean).join(" ")
            }));

            // Count members + poverty stats
            const totalMembers = familyMembersList.length;
            totalMembersCount += totalMembers;
            const povertyStatus = family.poverty || "--";
            if (povertyStatus === "Indigent") totalIndigent++;
            if (povertyStatus === "Low Income") totalLowIncome++;
            if (povertyStatus === "Non-Indigent") totalNonIndigent++;

            return {
                _id: family._id,
        householdId: householdInfo._id,
                houseNo: householdInfo.houseNo,
                purok: householdInfo.purok,
                familyHead: familyHeadName,
                totalMembers,
                poverty: povertyStatus,
                members: membersData
            };
        });

        // Compute statistics
        const totalFamilies = families.length;
        const avgMembersPerFamily = totalFamilies > 0 ? (totalMembersCount / totalFamilies).toFixed(2) : 0;

        res.render("fml", {
            layout: "layout",
            title: "Families",
            activePage: "fml",
            families: familyList,
            totalFamilies,
            avgMembersPerFamily,
            totalIndigent,
            totalLowIncome,
            totalNonIndigent,
            titlePage: "Families from Purok Shortcut"
        });

    } catch (err) {
        console.error("Error fetching family data:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/fml", isLogin, async (req, res) => {

    try {
        // Fetch only non-archived families, households, and residents
        const [families, households, residents] = await Promise.all([
            db.collection("family").find({ archive: { $in: [0, "0"] } }).toArray(),
            db.collection("household").find({ archive: { $in: [0, "0"] } }).toArray(),
            db.collection("resident").find({ archive: { $in: [0, "0"] } }).toArray()
        ]);

        // Create a map for quick household lookup
        const householdMap = Object.fromEntries(households.map(house => [
            house._id.toString(),
            { _id: house._id, houseNo: house.houseNo || "--", purok: house.purok }
        ]));

        // Initialize total counts
        let totalMembersCount = 0;
        let totalIndigent = 0;
        let totalLowIncome = 0;
        let totalNonIndigent = 0;

        // Process families
        const familyList = families.map(family => {
            const householdInfo = householdMap[family.householdId?.toString()] || { houseNo: "--", purok: "--"};

            // Get ALL residents of the family (both head and members)
            const familyMembersList = residents.filter(resident => 
                resident.familyId?.toString() === family._id.toString()
            );

            // Find the family head from the filtered list
            const familyHead = familyMembersList.find(resident => resident.role === "Head");

            // Handle missing names gracefully
            const familyHeadName = familyHead
                ? [familyHead.firstName, familyHead.middleName, familyHead.lastName, familyHead.extName].filter(Boolean).join(" ")
                : "--";

            // Prepare a list of all members with full names
            const membersData = familyMembersList.map(member => {
                return {
                    ...member,
                    fullName: [member.firstName, member.middleName, member.lastName, member.extName].filter(Boolean).join(" ")
                };
            });

            // The rest of the code remains the same
            const totalMembers = familyMembersList.length;
            totalMembersCount += totalMembers;
            const povertyStatus = family.poverty || "--";
            if (povertyStatus === "Indigent") totalIndigent++;
            if (povertyStatus === "Low Income") totalLowIncome++;
            if (povertyStatus === "Non-Indigent") totalNonIndigent++;

            return {
                _id: family._id,
                householdId: householdInfo._id,
                houseNo: householdInfo.houseNo,
                purok: householdInfo.purok,
                familyHead: familyHeadName,
                totalMembers,
                poverty: povertyStatus,
                members: membersData,
                familyIncome: family.familyIncome
            };
        });

        // Compute statistics
        const totalFamilies = families.length;
        const avgMembersPerFamily = totalFamilies > 0 ? (totalMembersCount / totalFamilies).toFixed(2) : 0;

        res.render("fml", {
            layout: "layout",
            title: "Families",
            activePage: "fml",
            families: familyList,
            totalFamilies,
            avgMembersPerFamily,
            totalIndigent,
            totalLowIncome,
            totalNonIndigent,
            titlePage: "Records of Families",
        });
    } catch (err) {
        console.error("Error fetching family data:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});


app.get("/vtr", isLogin, async (req, res) => {
    try {
        // Fetch residents with household details (houseNo, purok) based on householdId
        const residents = await db.collection("resident").aggregate([
            {
                $match: {
                    archive: { $in: [0, "0"] },
                    $or: [
                        { precinct: "Registered Voter" },
                        { precinct: "Non-Voter" }
                    ]
                }
            },
            {
                $addFields: {
                    householdObjId: {
                        $cond: {
                            if: { $eq: [{ $type: "$householdId" }, "objectId"] },
                            then: "$householdId",
                            else: {
                                $cond: {
                                    if: { $regexMatch: { input: "$householdId", regex: "^[a-fA-F0-9]{24}$" } },
                                    then: { $toObjectId: "$householdId" },
                                    else: null
                                }
                            }
                        }
                    }
                }
            },
            {
                $lookup: {
                    from: "household", // Look up the household collection
                    localField: "householdObjId", // Field in resident collection
                    foreignField: "_id", // Field in household collection
                    as: "householdDetails" // The result will be stored in this field
                }
            },
            {
                $unwind: { path: "$householdDetails", preserveNullAndEmptyArrays: true } // Unwind the array to get a flat structure
            },
            {
                $sort: { firstName: 1 } // Sort by firstName
            }
        ]).toArray();

        const months = {
            "January": 1, "February": 2, "March": 3, "April": 4, "May": 5, "June": 6,
            "July": 7, "August": 8, "September": 9, "October": 10, "November": 11, "December": 12
        };

        const calculateAge = (bDay, bMonth, bYear) => {
            const month = parseInt(bMonth); // Ensure that bMonth is a number
            if (isNaN(month)) return 0; // If month is invalid, return 0
        
            const birthDateString = `${bYear}-${String(month).padStart(2, '0')}-${String(bDay).padStart(2, '0')}`;
            const birthDate = new Date(birthDateString);
        
            if (isNaN(birthDate)) return 0; // If the birthDate is invalid, return 0
        
            const ageDifMs = Date.now() - birthDate.getTime();
            return Math.abs(new Date(ageDifMs).getUTCFullYear() - 1970);
        };
        

        let totalResidents = residents.length;
        let totalVoters = 0;
        let totalNonVoters = 0;
        let totalSKVoters = 0; // SK Voter: Age between 16 and 29
        let totalYouth = 0; // Age 16 to 29

        residents.forEach(resident => {
            resident.age = calculateAge(resident.bDay, resident.bMonth, resident.bYear); // Add age property

            // Count Registered Voters and Non-Voters
            if (resident.precinct === "Registered Voter") {
                totalVoters++;
            } else if (resident.precinct === "Non-Voter") {
                totalNonVoters++;
            }

            // Count SK Voters (16 to 29 years old)
            if (resident.age >= 16 && resident.age <= 30) {
                totalYouth++;
                if (resident.precinct === "Registered Voter") {
                    totalSKVoters++; // Only count SK Voters that are "Registered Voter"
                }
            }
        });

        // Calculate Percentages
        let voterPercentage = totalResidents > 0 ? ((totalVoters / totalResidents) * 100).toFixed(2) : 0;
        let nonVoterPercentage = totalResidents > 0 ? ((totalNonVoters / totalResidents) * 100).toFixed(2) : 0;
        let skVoterPercentage = totalResidents > 0 ? ((totalSKVoters / totalResidents) * 100).toFixed(2) : 0;
        let youthPercentage = totalResidents > 0 ? ((totalYouth / totalResidents) * 100).toFixed(2) : 0;

        console.log(`Total Residents: ${totalResidents}, Voters: ${totalVoters} (${voterPercentage}%), Non-Voters: ${totalNonVoters} (${nonVoterPercentage}%), SK Voters: ${totalSKVoters} (${skVoterPercentage}%), Youth: ${totalYouth} (${youthPercentage}%)`);

        // Pass the household details to the render function
        res.render("vtr", {
            layout: "layout",
            title: "Voter's List",
            activePage: "vtr",
            residents,
            totalResidents,
            totalVoters,
            voterPercentage,
            totalNonVoters,
            nonVoterPercentage,
            totalSKVoters,
            skVoterPercentage,
            totalYouth,
            youthPercentage,
            titlePage: "Registered Voter's List"
        });
    } catch (err) {
        console.error("Error fetching residents:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});


app.get("/vtrReg", isLogin, async (req, res) => {
    try {
        // Fetch residents with household details (houseNo, purok) based on householdId
        const residents = await db.collection("resident").aggregate([
            {
                $match: {
                    archive: { $in: [0, "0"] },
                    $or: [
                        { precinct: "Registered Voter" }
                    ]
                }
            },
            {
                $addFields: {
                    householdObjId: {
                        $cond: {
                            if: { $eq: [{ $type: "$householdId" }, "objectId"] },
                            then: "$householdId",
                            else: {
                                $cond: {
                                    if: { $regexMatch: { input: "$householdId", regex: "^[a-fA-F0-9]{24}$" } },
                                    then: { $toObjectId: "$householdId" },
                                    else: null
                                }
                            }
                        }
                    }
                }
            },
            {
                $lookup: {
                    from: "household", // Look up the household collection
                    localField: "householdObjId", // Field in resident collection
                    foreignField: "_id", // Field in household collection
                    as: "householdDetails" // The result will be stored in this field
                }
            },
            {
                $unwind: { path: "$householdDetails", preserveNullAndEmptyArrays: true } // Unwind the array to get a flat structure
            },
            {
                $sort: { firstName: 1 } // Sort by firstName
            }
        ]).toArray();

        const months = {
            "January": 1, "February": 2, "March": 3, "April": 4, "May": 5, "June": 6,
            "July": 7, "August": 8, "September": 9, "October": 10, "November": 11, "December": 12
        };

        const calculateAge = (bDay, bMonth, bYear) => {
            const month = parseInt(bMonth); // Ensure that bMonth is a number
            if (isNaN(month)) return 0; // If month is invalid, return 0
        
            const birthDateString = `${bYear}-${String(month).padStart(2, '0')}-${String(bDay).padStart(2, '0')}`;
            const birthDate = new Date(birthDateString);
        
            if (isNaN(birthDate)) return 0; // If the birthDate is invalid, return 0
        
            const ageDifMs = Date.now() - birthDate.getTime();
            return Math.abs(new Date(ageDifMs).getUTCFullYear() - 1970);
        };
        

        let totalResidents = residents.length;
        let totalVoters = 0;
        let totalNonVoters = 0;
        let totalSKVoters = 0; // SK Voter: Age between 16 and 29
        let totalYouth = 0; // Age 16 to 29

        residents.forEach(resident => {
            resident.age = calculateAge(resident.bDay, resident.bMonth, resident.bYear); // Add age property

            // Count Registered Voters and Non-Voters
            if (resident.precinct === "Registered Voter") {
                totalVoters++;
            } else if (resident.precinct === "Non-Voter") {
                totalNonVoters++;
            }

            // Count SK Voters (16 to 29 years old)
            if (resident.age >= 16 && resident.age <= 30) {
                totalYouth++;
                if (resident.precinct === "Registered Voter") {
                    totalSKVoters++; // Only count SK Voters that are "Registered Voter"
                }
            }
        });

        // Calculate Percentages
        let voterPercentage = totalResidents > 0 ? ((totalVoters / totalResidents) * 100).toFixed(2) : 0;
        let nonVoterPercentage = totalResidents > 0 ? ((totalNonVoters / totalResidents) * 100).toFixed(2) : 0;
        let skVoterPercentage = totalResidents > 0 ? ((totalSKVoters / totalResidents) * 100).toFixed(2) : 0;
        let youthPercentage = totalResidents > 0 ? ((totalYouth / totalResidents) * 100).toFixed(2) : 0;

        console.log(`Total Residents: ${totalResidents}, Voters: ${totalVoters} (${voterPercentage}%), Non-Voters: ${totalNonVoters} (${nonVoterPercentage}%), SK Voters: ${totalSKVoters} (${skVoterPercentage}%), Youth: ${totalYouth} (${youthPercentage}%)`);

        // Pass the household details to the render function
        res.render("vtrReg", {
            layout: "layout",
            title: "Voter's List",
            activePage: "vtr",
            residents,
            totalResidents,
            totalVoters,
            voterPercentage,
            totalNonVoters,
            nonVoterPercentage,
            totalSKVoters,
            skVoterPercentage,
            totalYouth,
            youthPercentage
        });
    } catch (err) {
        console.error("Error fetching residents:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/vtrNon", isLogin, async (req, res) => {
    try {
        // Fetch all residents, including household details (houseNo, purok) based on householdId
        const residents = await db.collection("resident").aggregate([
            {
                $match: {
                    archive: { $in: [0, "0"] },
                    $or: [
                        { precinct: "Registered Voter" },
                        { precinct: "Non-Voter" }
                    ]
                }
            },
            {
                $lookup: {
                    from: "household", // Look up the household collection
                    localField: "householdId", // Field in resident collection
                    foreignField: "_id", // Field in household collection
                    as: "householdDetails" // The result will be stored in this field
                }
            },
            {
                $unwind: { path: "$householdDetails", preserveNullAndEmptyArrays: true } // Unwind the array to get a flat structure
            },
            {
                $sort: { firstName: 1 } // Sort by firstName
            }
        ]).toArray();

        const months = {
            "January": 1, "February": 2, "March": 3, "April": 4, "May": 5, "June": 6,
            "July": 7, "August": 8, "September": 9, "October": 10, "November": 11, "December": 12
        };

        // Function to calculate age
        const calculateAge = (bDay, bMonth, bYear) => {
            const month = parseInt(bMonth); // Ensure that bMonth is a number
            if (isNaN(month)) return 0; // If month is invalid, return 0
        
            const birthDateString = `${bYear}-${String(month).padStart(2, '0')}-${String(bDay).padStart(2, '0')}`;
            const birthDate = new Date(birthDateString);
        
            if (isNaN(birthDate)) return 0; // If the birthDate is invalid, return 0
        
            const ageDifMs = Date.now() - birthDate.getTime();
            return Math.abs(new Date(ageDifMs).getUTCFullYear() - 1970);
        };

        // Totals initialization
        let totalResidents = residents.length;
        let totalVoters = 0;
        let totalNonVoters = 0;
        let totalSKVoters = 0; // SK Voter: Age between 16 and 29
        let totalYouth = 0; // Age 16 to 29

        residents.forEach(resident => {
            resident.age = calculateAge(resident.bDay, resident.bMonth, resident.bYear); // Add age property

            // Count Registered Voters and Non-Voters
            if (resident.precinct === "Registered Voter") {
                totalVoters++;
            } else if (resident.precinct === "Non-Voter") {
                totalNonVoters++;
            }

            // Count SK Voters (16 to 29 years old)
            if (resident.age >= 15 && resident.age <= 30) {
                totalYouth++;
                if (resident.precinct === "Registered Voter") {
                    totalSKVoters++; // Only count SK Voters that are "Registered Voter"
                }
            }
        });

        // Calculate Percentages
        let voterPercentage = totalResidents > 0 ? ((totalVoters / totalResidents) * 100).toFixed(2) : 0;
        let nonVoterPercentage = totalResidents > 0 ? ((totalNonVoters / totalResidents) * 100).toFixed(2) : 0;
        let skVoterPercentage = totalResidents > 0 ? ((totalSKVoters / totalResidents) * 100).toFixed(2) : 0;
        let youthPercentage = totalResidents > 0 ? ((totalYouth / totalResidents) * 100).toFixed(2) : 0;

        console.log(`Total Residents: ${totalResidents}, Voters: ${totalVoters} (${voterPercentage}%), Non-Voters: ${totalNonVoters} (${nonVoterPercentage}%), SK Voters: ${totalSKVoters} (${skVoterPercentage}%), Youth: ${totalYouth} (${youthPercentage}%)`);

        // Pass the data to the render function
        res.render("vtr", {
            layout: "layout",
            title: "Non-Voter's List",
            activePage: "vtr",
            residents,
            totalResidents,
            totalVoters,
            voterPercentage,
            totalNonVoters,
            nonVoterPercentage,
            totalSKVoters,
            skVoterPercentage,
            totalYouth,
            youthPercentage,
            titlePage: "Non-Voters' List"
        });
    } catch (err) {
        console.error("Error fetching residents:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.get("/vtrSK", isLogin, async (req, res) => {
    try {
        // Fetch all residents, including household details (houseNo, purok) based on householdId
        const residents = await db.collection("resident").aggregate([
            {
                $match: {
                    archive: { $in: [0, "0"] },
                    $or: [
                        { precinct: "Registered Voter" },
                        { precinct: "Non-Voter" }
                    ]
                }
            },
            {
                $lookup: {
                    from: "household", // Look up the household collection
                    localField: "householdId", // Field in resident collection
                    foreignField: "_id", // Field in household collection
                    as: "householdDetails" // The result will be stored in this field
                }
            },
            {
                $unwind: { path: "$householdDetails", preserveNullAndEmptyArrays: true } // Unwind the array to get a flat structure
            },
            {
                $sort: { firstName: 1 } // Sort by firstName
            }
        ]).toArray();

        const months = {
            "January": 1, "February": 2, "March": 3, "April": 4, "May": 5, "June": 6,
            "July": 7, "August": 8, "September": 9, "October": 10, "November": 11, "December": 12
        };

        // Function to calculate age
        const calculateAge = (bDay, bMonth, bYear) => {
            const month = parseInt(bMonth); // Ensure that bMonth is a number
            if (isNaN(month)) return 0; // If month is invalid, return 0
        
            const birthDateString = `${bYear}-${String(month).padStart(2, '0')}-${String(bDay).padStart(2, '0')}`;
            const birthDate = new Date(birthDateString);
        
            if (isNaN(birthDate)) return 0; // If the birthDate is invalid, return 0
        
            const ageDifMs = Date.now() - birthDate.getTime();
            return Math.abs(new Date(ageDifMs).getUTCFullYear() - 1970);
        };

        // Totals initialization
        let totalResidents = residents.length;
        let totalVoters = 0;
        let totalNonVoters = 0;
        let totalSKVoters = 0; // SK Voter: Age between 16 and 29
        let totalYouth = 0; // Age 16 to 29

        let skResidents = [];

        residents.forEach(resident => {
            resident.age = calculateAge(resident.bDay, resident.bMonth, resident.bYear); // Add age property

            // Count Registered Voters and Non-Voters
            if (resident.precinct === "Registered Voter") {
                totalVoters++;
            } else if (resident.precinct === "Non-Voter") {
                totalNonVoters++;
            }

            // Count SK Voters (16 to 29 years old)
            if (resident.age >= 16 && resident.age <= 30) {
                totalYouth++;
                if (resident.precinct === "Registered Voter") {
                    totalSKVoters++; // Only count SK Voters that are "Registered Voter"
                    skResidents.push(resident); // Add to the list of SK Voters
                }
            }
        });

        // Calculate Percentages
        let voterPercentage = totalResidents > 0 ? ((totalVoters / totalResidents) * 100).toFixed(2) : 0;
        let nonVoterPercentage = totalResidents > 0 ? ((totalNonVoters / totalResidents) * 100).toFixed(2) : 0;
        let skVoterPercentage = totalResidents > 0 ? ((totalSKVoters / totalResidents) * 100).toFixed(2) : 0;
        let youthPercentage = totalResidents > 0 ? ((totalYouth / totalResidents) * 100).toFixed(2) : 0;

        console.log(`Total Residents: ${totalResidents}, Voters: ${totalVoters} (${voterPercentage}%), Non-Voters: ${totalNonVoters} (${nonVoterPercentage}%), SK Voters: ${totalSKVoters} (${skVoterPercentage}%), Youth: ${totalYouth} (${youthPercentage}%)`);

        // Pass the data to the render function
        res.render("vtrSK", {
            layout: "layout",
            title: "SK Voter's List",
            activePage: "vtrSK",
            skResidents,
            totalResidents,
            totalVoters,
            voterPercentage,
            totalNonVoters,
            nonVoterPercentage,
            totalSKVoters,
            skVoterPercentage,
            totalYouth,
            youthPercentage,
            titlePage: "SK Voters' List"
        });
    } catch (err) {
        console.error("Error fetching residents:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.post('/add-case', async (req, res) => {
    try {
        console.log("Received Data:", req.body);
        const { type, complainants, complainees } = req.body;

        if (!type) {
            return res.status(400).json({ error: "Type of case is required." });
        }

        // Generate Case Number
        const now = new Date();
        const year = now.getFullYear();
        const month = String(now.getMonth() + 1).padStart(2, '0');

        const count = await db.collection('cases').countDocuments({
            caseNo: { $regex: `^${year}-${month}` }
        });

        const sequence = String(count + 1).padStart(4, '0');
        const caseNo = `${year}-${month}${sequence}`;
        console.log("Generated Case No:", caseNo);

        // Insert new case
        const caseData = {
            caseNo,
            type,
            status: "Pending",
            createdAt: now
        };

        const caseResult = await db.collection('cases').insertOne(caseData);
        const caseId = caseResult.insertedId;
        console.log("Case inserted with ID:", caseId);

        // Format complainants & complainees
        const formatPersons = (persons, role) => {
            if (!persons) return [];
            try {
                const parsedPersons = Array.isArray(persons)
                    ? persons.map(p => (typeof p === 'string' ? JSON.parse(p) : p))
                    : [typeof persons === 'string' ? JSON.parse(persons) : persons];

                return parsedPersons.map(person => ({
                    caseId,
                    name: person.name.trim(),
                    address: person.address ? person.address.trim() : "No Address",
                    phone: person.phone ? person.phone.trim() : "No Phone"
                }));
            } catch (error) {
                console.error(`Error parsing ${role}:`, error);
                return [];
            }
        };

        // Insert complainants
        const complainantList = formatPersons(complainants, "Complainants");
        if (complainantList.length > 0) {
            await db.collection('complainants').insertMany(complainantList);
            console.log(`Inserted ${complainantList.length} complainants.`);
        }

        // Insert complainees
        const complaineeList = formatPersons(complainees, "Complainees");
        if (complaineeList.length > 0) {
            await db.collection('complainees').insertMany(complaineeList);
            console.log(`Inserted ${complaineeList.length} complainees.`);
        }

        // Redirect with success message as a query parameter
        return res.redirect(`/viewCmp/${caseId}?success=Case added successfully! Case No: ${caseNo}`);

    } catch (error) {
        console.error("Error inserting case:", error);
        res.redirect(`/viewCmp/error?error=An error occurred while adding the case.`);
    }
});

app.get("/cmp", isLogin, isRsd, isHr, async (req, res) => {
    try {
        // Fetch all cases, ordered by createdAt (latest first)
        const cases = await db.collection("cases")
        .find({ archive: { $in: ["0", 0] } }) // Filters only archive: 0
        .sort({ createdAt: -1 })
        .toArray();

        // Extract resident IDs from cases (complainants and respondents)
        const residentIds = cases.flatMap(c => [...c.complainants, ...c.respondents])
            .filter(id => id) // Remove empty or undefined values
            .map(id => ObjectId.isValid(id) ? new ObjectId(id) : id);

        console.log("Resident IDs for lookup:", residentIds); // Debugging log

        // Fetch residents using `_id` (Check both ObjectId and String formats)
        const residentsData = await db.collection("resident").find({
            _id: { $in: residentIds }
        }).toArray();

        console.log("Residents found:", residentsData); // Debugging log

        // Map resident IDs to full names
        const residentsMap = {};
        residentsData.forEach(resident => {
            const residentIdStr = resident._id.toString(); // Convert `_id` to string
            residentsMap[residentIdStr] = `${resident.firstName} ${resident.middleName || ''} ${resident.lastName} ${resident.extName || ''}`.trim();
        });

        console.log("Residents Map:", residentsMap); // Debugging log

        // Organize complainants and respondents by caseId
        const complainantsByCase = {};
        const respondentsByCase = {};
        cases.forEach(c => {
            complainantsByCase[c._id] = c.complainants.map(id => residentsMap[id] || "Unknown");
            respondentsByCase[c._id] = c.respondents.map(id => residentsMap[id] || "Unknown");
        });

        console.log("Final Complainants by Case:", complainantsByCase); // Debugging log
        console.log("Final Respondents by Case:", respondentsByCase); // Debugging log

        // Fetch all schedules and group them by caseId
        const schedules = await db.collection("schedule").find().toArray();
        const schedulesByCase = {};
        schedules.forEach(s => {
            if (!schedulesByCase[s.caseId]) schedulesByCase[s.caseId] = [];
            schedulesByCase[s.caseId].push(s);
        });

        // Render the 'cmp' view with all data
        res.render("cmp", { 
            layout: "layout", 
            title: "Complaints", 
            activePage: "cmp",
            cases,
            complainantsByCase,
            respondentsByCase,
            schedulesByCase
        });
    } catch (error) {
        console.error("Error fetching cases:", error);
        res.status(500).send("An error occurred while retrieving cases.");
    }
});


app.get("/cmpNew", isLogin, isRsd, isHr, (req, res) => res.render("cmpNew", { layout: "layout", title: "Add Complaint", activePage: "cmp" }));

app.get('/viewCmp/:id', isRsd, isLogin, async (req, res) => {
    try {
        const caseId = req.params.id;
        const error = req.query.error || ""; // ✅ Capture error message from query parameter
        console.log("Fetching case with ID:", caseId);

        // ✅ Validate caseId format
        if (!ObjectId.isValid(caseId)) {
            return res.redirect('/?error=Invalid case ID');
        }

        // ✅ Fetch case details
        const caseData = await db.collection('cases').findOne({ _id: new ObjectId(caseId) });
        if (!caseData) {
            return res.redirect('/?error=Case not found');
        }

        // ✅ Fetch complainants & complainees
        const [complainants, complainees] = await Promise.all([
            db.collection('complainants').find({ caseId: new ObjectId(caseId) }).toArray(),
            db.collection('complainees').find({ caseId: new ObjectId(caseId) }).toArray()
        ]);

        // ✅ Fetch schedules where caseId matches
        const schedules = await db.collection('schedule').find({ caseId: caseId }).toArray();
        console.log("Schedules Found:", schedules);

        // ✅ Extract unique resident IDs from schedules
        const residentIds = schedules.flatMap(schedule => 
            [schedule.chair, schedule.secretary, schedule.member].filter(id => id)
        ).map(id => new ObjectId(id));

        const uniqueResidentIds = [...new Set(residentIds)];
        console.log("Fetching residents with IDs:", uniqueResidentIds);

        // ✅ Fetch residents (Chair, Secretary, Member) based on IDs
        const residents = uniqueResidentIds.length > 0 
            ? await db.collection('resident').find({ _id: { $in: uniqueResidentIds } }).toArray()
            : [];

        // ✅ Attach resident details to schedules
        schedules.forEach(schedule => {
            schedule.chair = residents.find(res => res._id.toString() === schedule.chair) || { firstName: "N/A" };
            schedule.secretary = residents.find(res => res._id.toString() === schedule.secretary) || { firstName: "N/A" };
            schedule.member = residents.find(res => res._id.toString() === schedule.member) || { firstName: "N/A" };
        });

        // ✅ Render the page with the error message
        res.render('viewCmp', { 
            caseData, complainants, complainees, schedules, error,
            layout: "layout", title: "Add Complaint", activePage: "cmp" 
        });

    } catch (err) {
        console.error("Error fetching case:", err);
        res.redirect('/?error=An error occurred while fetching the case');
    }
});



app.post('/add-schedule', async (req, res) => {
    try {
        const { caseId, chair, secretary, member, month, day, year, time } = req.body;

        if (!caseId || !chair || !secretary || !member || !month || !day || !year || !time) {
            return res.redirect(`/viewCmp/${caseId}?error=Please fill out all required fields`);
        }

        // Check if a schedule already exists with the same day, month, year, and time
        const existingSchedule = await db.collection("schedule").findOne({
            caseId,
            day,
            month,
            year,
            time
        });

        if (existingSchedule) {
            return res.redirect(`/viewCmp/${caseId}?error=Schedule already exists`);
        }

        // If no exact match found, insert new schedule
        const newSchedule = {
            caseId,
            chair,
            secretary,
            member,
            day,
            month,
            year,
            time,
            status: 'Pending',
            createdAt: new Date(),
            updatedAt: new Date()
        };

        await db.collection("schedule").insertOne(newSchedule);

        return res.redirect(`/viewCmp/${caseId}`);

    } catch (error) {
        console.error("Error adding schedule:", error.message);
        res.redirect(`/viewCmp/${caseId}?error=Internal Server Error! Please try again.`);
    }
});


app.post('/delete-sched/:id', async (req, res) => {
    try {
        const scheduleId = req.params.id;

        // Find the schedule first to get the caseId
        const schedule = await db.collection('schedule').findOne({ _id: new ObjectId(scheduleId) });

        if (!schedule) {
            return res.send('<script>alert("Schedule not found!"); window.history.back();</script>');
        }

        // Get the caseId before deletion
        const caseId = schedule.caseId;

        // Delete the schedule
        const result = await db.collection('schedule').deleteOne({ _id: new ObjectId(scheduleId) });

        if (result.deletedCount === 0) {
            return res.send('<script>alert("Failed to delete schedule!"); window.history.back();</script>');
        }

        // Redirect to viewCmp/:caseId
        res.send(`<script>alert("Schedule deleted successfully!"); window.location="/viewCmp/${caseId}";</script>`);

    } catch (error) {
        console.error("Error deleting schedule:", error);
        res.status(500).send('<script>alert("Internal Server Error!"); window.history.back();</script>');
    }
});

app.post("/myUpdate", requireAuth, async (req, res) => {
    try {
        const { email, phone } = req.body;
        const userId = req.session.userId; // Get the logged-in user's ID from session

        if (!ObjectId.isValid(userId)) {
            return res.status(400).send("Invalid user ID");
        }

        // Update user in MongoDB
        await db.collection("resident").updateOne(
            { _id: new ObjectId(userId) },
            { $set: { email, phone } }
        );

        res.redirect("/prf"); // Redirect to the profile page after update
    } catch (err) {
        console.error("❌ Error updating user:", err);
        res.status(500).send("Error updating user information");
    }
});


app.post("/myPassword", requireAuth, async (req, res) => {
    try {
        const { password } = req.body;
        const userId = req.session.userId; // Get the logged-in user's ID from session

        if (!ObjectId.isValid(userId)) {
            return res.status(400).send("Invalid user ID");
        }

        // Update user in MongoDB
        await db.collection("resident").updateOne(
            { _id: new ObjectId(userId) },
            { $set: { password } }
        );

        res.redirect("/prf"); // Redirect to the profile page after update
    } catch (err) {
        console.error("❌ Error updating user:", err);
        res.status(500).send("Error updating user information");
    }
});

app.post("/myPasswordRST", requireAuth, async (req, res) => {
    try {
        const { password } = req.body;
        const userId = req.session.userId; // Get the logged-in user's ID from session

        if (!ObjectId.isValid(userId)) {
            return res.status(400).send("Invalid user ID");
        }

        // Update user in MongoDB: set new password & reset = 0
        await db.collection("resident").updateOne(
            { _id: new ObjectId(userId) },
            { $set: { password, reset: 0 } }
        );

        res.redirect("/prf"); // Redirect to the profile page after update
    } catch (err) {
        console.error("❌ Error updating user:", err);
        res.status(500).send("Error updating user information");
    }
});


app.get("/api/success-per-month", async (req, res) => {
    try {
        const monthlySuccess = new Array(12).fill(0);
        let totalRequests = 0;

        const successDocuments = await db.collection("request").find({
            status: { $in: ["Success", "Approved", "Processed"] },
            archive: { $in: [0, "0"] }
        }).toArray();

        successDocuments.forEach(doc => {
            if (doc.updatedAt) {
                let monthIndex = new Date(doc.updatedAt).getMonth();
                if (!isNaN(monthIndex) && monthIndex >= 0 && monthIndex < 12) {
                    monthlySuccess[monthIndex]++;
                    totalRequests++; // Increment total count
                }
            }
        });

        res.json({ monthlySuccess, totalRequests });
    } catch (error) {
        console.error("Error fetching success documents:", error);
        res.json({ monthlySuccess: new Array(12).fill(0), totalRequests: 0 });
    }
});
app.get("/api/age-distribution", async (req, res) => {
    try {
        const ageGroups = {
            "0-5 Months": 0,
            "6-11 Months": 0,
            "1-5 Years Old": 0,
            "6-12 Years Old": 0,
            "13-17 Years Old": 0,
            "18-59 Years Old": 0,
            "60 and above": 0
        };
        let totalResidents = 0;

        const residents = await db.collection("resident").find({ archive: { $in: [0, "0"] } }).toArray();
        
        const currentDate = new Date();
        const currentYear = currentDate.getFullYear();
        const currentMonth = currentDate.getMonth() + 1; // Month is 0-indexed, so we add 1
        const currentDay = currentDate.getDate();

        residents.forEach(resident => {
            // Exclude residents with future birth dates
            if (resident.bYear && resident.bMonth && resident.bDay) {
                const birthYear = parseInt(resident.bYear);
                const birthMonth = new Date(Date.parse(resident.bMonth + " 1, 2000")).getMonth() + 1; // Convert month name to number
                const birthDay = parseInt(resident.bDay);

                const birthDate = new Date(birthYear, birthMonth - 1, birthDay);

                // If the birth date is in the future, skip the resident
                if (birthDate > currentDate) {
                    console.log(`Skipping future birth date for Resident: ${resident._id}`);
                    return;
                }

                let age = currentYear - birthYear;
                let monthDiff = currentMonth - birthMonth;
                let dayDiff = currentDay - birthDay;

                // Adjust if the birthday hasn't occurred yet this year
                if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) {
                    age--;
                }

                // Handle cases where age is less than 1 year (0-11 months)
                if (age < 1) {
                    // Calculate the total months old, considering potential negative month differences
                    let monthsOld = (currentYear - birthYear) * 12 + (currentMonth - birthMonth);
                    if (monthsOld < 0) {
                        monthsOld += 12; // Adjust if the month difference is negative (future birth date or invalid data)
                    }
                    console.log(`Months Old: ${monthsOld}`); // Log to check

                    // Handle 0-5 months and 6-11 months
                    if (monthsOld >= 0 && monthsOld <= 5) {
                        ageGroups["0-5 Months"]++;
                    } else if (monthsOld >= 6 && monthsOld <= 11) {
                        ageGroups["6-11 Months"]++;
                    }
                } 
                // Group for 1 year old and above
                else if (age >= 1 && age <= 5) {
                    ageGroups["1-5 Years Old"]++;
                } else if (age >= 6 && age <= 12) {
                    ageGroups["6-12 Years Old"]++;
                } else if (age >= 13 && age <= 17) {
                    ageGroups["13-17 Years Old"]++;
                } else if (age >= 18 && age <= 59) {
                    ageGroups["18-59 Years Old"]++;
                } else {
                    ageGroups["60 and above"]++;
                }
                
                totalResidents++;
            }
        });

        // Log the final counts for debugging
        console.log("Age Groups:", ageGroups);
        
        // Calculate percentages for each age group
        const ageGroupPercentages = {};
        Object.keys(ageGroups).forEach(group => {
            ageGroupPercentages[group] = totalResidents > 0 
                ? ((ageGroups[group] / totalResidents) * 100).toFixed(2) + "%" 
                : "0%";
        });

        res.json({ ageGroups, ageGroupPercentages, totalResidents });
    } catch (error) {
        console.error("Error fetching resident data:", error);
        res.status(500).json({ message: "Internal Server Error" });
    }
});



app.get("/issuedChart", isLogin, sumReq, (req, res) => res.render("issuedChart", { layout: "layout", title: "Dashboard", activePage: "dsb" }));
app.get("/ageChart", isLogin, sumReq, (req, res) => res.render("ageChart", { layout: "layout", title: "Dashboard", activePage: "dsb" }));

app.get("/rqt", isLogin, isAnn, myReq, async (req, res) => {
    console.log("🔐 User Access Level:", req.session.access);
    console.log("📌 Session Data:", req.session); // Debug session variables

    if (req.session.access !== 1) return res.redirect("/");

    try {
        const userId = req.session.userId;
        if (!userId) throw new Error("User ID not found in session.");

        // Convert userId to ObjectId if valid
        const userObjectId = ObjectId.isValid(userId) ? new ObjectId(userId) : userId;

        console.log("👤 Logged-in User ID:", userObjectId);

        // Fetch cases where the user is a Complainee or Complainant
        const [complaineeCases, complainantCases] = await Promise.all([
            db.collection("complainees").find({ name: { $in: [userObjectId, userId] } }).toArray(),
            db.collection("complainants").find({ name: { $in: [userObjectId, userId] } }).toArray(),
        ]);

        console.log("📌 Complainee Cases Found:", complaineeCases.length);
        console.log("📌 Complainant Cases Found:", complainantCases.length);

        // Extract unique Case IDs
        const allCaseIds = [...new Set([...complaineeCases.map(c => c.caseId), ...complainantCases.map(c => c.caseId)])];

        console.log("⚖️ Matched Case IDs:", allCaseIds);

        // Convert to valid ObjectIds
        const caseObjectIds = allCaseIds
            .filter(id => ObjectId.isValid(id))
            .map(id => new ObjectId(id));

        console.log("🆔 Valid ObjectIds:", caseObjectIds);

        // Fetch 'Pending' cases
        const pendingCases = caseObjectIds.length
            ? await db.collection("cases").countDocuments({ _id: { $in: caseObjectIds }, status: "Pending" })
            : 0;

        console.log("📌 Pending Cases Count:", pendingCases);

        res.render("rqt", {
            layout: "layout",
            title: "Request",
            activePage: "rqt",
            pendingCases, // Accurate count of pending cases
        });

    } catch (error) {
        console.error("❌ Error fetching pending cases:", error);
        res.status(500).send("Internal Server Error");
    }
});


app.get("/rqtAll", isLogin, isAnn, myReq, (req, res) => {
    console.log("User Access Level:", req.session.access);  // Log the access level
    if (req.session.access !== 1) return res.redirect("/"); // If access is not 0, redirect to home
    res.render("rqtAll", { layout: "layout", title: "Request", activePage: "rqt" });
});


app.post("/rqtDocument", isLogin, async (req, res) => {
    const sessionUserId = req.user._id;

    try {
        console.log("Request Body: ", req.body);

        let { type, qty, purpose, remarks } = req.body;
        type = [].concat(type);
        qty = [].concat(qty).map(Number);
        purpose = [].concat(purpose);
        remarks = [].concat(remarks || "");

        console.log("Extracted Data - type:", type, "qty:", qty, "purpose:", purpose, "remarks:", remarks);

        if (type.length !== qty.length || type.length !== purpose.length) {
            return res.status(400).send('<script>alert("Mismatch in document fields! Please try again."); window.location="/rqt";</script>');
        }

        if (!type.length || !qty.length || !purpose.length) {
            return res.status(400).send('<script>alert("Please fill out all required fields."); window.location="/rqt";</script>');
        }

        const year = new Date().getFullYear().toString().slice(-2);
        const month = String(new Date().getMonth() + 1).padStart(2, "0");
        const requestByLastTwo = sessionUserId.toString().slice(-2);

        const newRequest = {
            createdAt: new Date(),
            updatedAt: new Date(),
            status: "Pending",
            requestBy: new ObjectId(sessionUserId),
            archive: 0
        };

        const result = await db.collection("request").insertOne(newRequest);
        const reqId = result.insertedId;
        const requestIdLastTwo = reqId.toString().slice(-2);
        const tr = `${year}${month}${requestByLastTwo}${requestIdLastTwo}`;

        await db.collection("request").updateOne(
            { _id: reqId },
            { $set: { tr } }
        );

        const documentPromises = type.map((docType, index) => {
            return db.collection("document").insertOne({
                reqId: reqId,
                remarks: remarks[index] || "",
                type: docType,
                qty: qty[index] || 1,
                purpose: purpose[index] || "",
                status: "Pending",
                createdAt: new Date(),
                updatedAt: new Date(),
                requestBy: new ObjectId(sessionUserId)
            });
        });

        await Promise.all(documentPromises);

        const resident = await db.collection("resident").findOne({ _id: new ObjectId(sessionUserId) });

        if (resident && resident.email) {
            const mailOptions = {
                from: "johnniebre1995@gmail.com",
                to: resident.email,
                subject: "Document Request Submitted Successfully",
                html: `
                    <p style="font-size: 20px; margin: 0;">Your request has been submitted successfully!</p>
                    <br>
                    <div style="font-size: 13px; text-align: center; font-weight: 500;">
                        The Barangay Secretary will review your request within 24 hours on business days and will notify you via email regarding its status. Weekends are excluded.
                    </div>
                `
            };

            try {
                await transporter.sendMail(mailOptions);
                console.log("Confirmation email sent to:", resident.email);
            } catch (emailError) {
                console.error("Failed to send confirmation email:", emailError.message);
            }
        }

        res.redirect("/rqtSuccess");

    } catch (err) {
        console.error("Error inserting request or document:", err);
        res.status(500).send('<script>alert("Error inserting request or document! Please try again."); window.location="/rqt";</script>');
    }
});

const myRqtView = async (req, res) => {
    try {
        if (!req.user) {
            console.log("User is not logged in.");
            return res.redirect("/");
        }

        const requestId = req.params.id;
        console.log("🔎 Request ID:", requestId);

        if (!ObjectId.isValid(requestId)) {
            console.log("❌ Invalid request ID format.");
            return res.status(400).send("Invalid request ID.");
        }

        const objectIdRequestId = new ObjectId(requestId);

        // Ensure sessionUserId is an ObjectId
        let sessionUserId = req.user._id;
        if (typeof sessionUserId === "string" && ObjectId.isValid(sessionUserId)) {
            sessionUserId = new ObjectId(sessionUserId);
        }

        console.log("✅ Converted sessionUserId:", sessionUserId);

        // Fetch the specific request
        const request = await db.collection("request").findOne({
            _id: objectIdRequestId,
            requestBy: sessionUserId,  // Ensure this matches the stored ObjectId
            archive: { $in: [0, "0"] } // Ensure not archived
        });

        if (!request) {
            console.log("❌ Request not found.");
            return res.status(404).send("Request not found.");
        }

        console.log("✅ Request Found:", request);

        // Fetch resident details (where requestBy matches resident._id)
        let resident = null;
        if (request.requestBy) {
            resident = await db.collection("resident").findOne({
                _id: new ObjectId(request.requestBy)
            });
        }

        console.log("👤 Resident Found:", resident);

        // Fetch all documents related to this request
        const documents = await db.collection("document")
            .find({ reqId: objectIdRequestId })
            .toArray();

        console.log(`📄 Documents Found: ${documents.length}`);

        // Attach documents to the request object
        request.documents = documents;

        // Render the EJS page with the data
        res.render("rqtView", { request, resident, documents, layout: "layout", title: "Request", activePage: "rqt"  });

    } catch (err) {
        console.error("⚠️ Error in myRqtView:", err);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
};

const generateRandomPassword = () => {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+";
    let password = "";
    for (let i = 0; i < 12; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
};

app.post("/forgotX", async (req, res) => {
    try {
        const { username, email } = req.body;

        if (!username) {
            return res.redirect("/forgot?error=" + encodeURIComponent("Username is required"));
        }

        const query = { username };
        if (email) query.email = email;

        const user = await db.collection("resident").findOne(query);

        if (!user) {
            return res.redirect("/forgot?error=" + encodeURIComponent("Invalid Credentials, Try Again!"));
        }

        const newPassword = generateRandomPassword();

        await db.collection("resident").updateOne(
            { _id: user._id },
            { $set: { password: newPassword, reset: 1 } }
        );

        let emailToSend = user.email;

        if (!emailToSend && user.headId) {
            const familyHead = await db.collection("resident").findOne({ _id: new ObjectId(user.headId) });
            emailToSend = familyHead ? familyHead.email : null;
        }

        if (!emailToSend) {
            return res.redirect("/forgot?error=" + encodeURIComponent("No email found for user or family head"));
        }

        // ✅ Nodemailer email content
        const mailOptions = {
            from: '"Barangay System" <yourgmail@gmail.com>',
            to: emailToSend,
            subject: 'Password Reset Request',
            html: `
                <p>A temporary password has been generated for your account:</p>
                <p style="font-size: 18px; font-weight: bold;">🔑 ${newPassword}</p>
                <p>Please log in and change your password immediately for security reasons.</p>
            `,
        };

        try {
            await transporter.sendMail(mailOptions);
        } catch (error) {
            console.error('Error sending email:', error);
            return res.redirect("/forgot?error=" + encodeURIComponent("Failed to send email"));
        }

        res.render("passSuccess", { username, email: emailToSend, error : "Password Reset Successfully!" });

    } catch (error) {
        console.error("Error resetting password:", error);
        res.redirect("/forgot?error=" + encodeURIComponent("Internal Server Error"));
    }
});


app.get("/rqtSuccess", isLogin, isReq, (req, res) => res.render("rqtSuccess", { layout: "design", title: "Services", activePage: "rqt" }));
app.get('/rqtView/:id', isLogin, myRqtView);


app.get("/fmlView/:id", isLogin, async (req, res) => {
    try {
        const residentId = new ObjectId(req.params.id);

        // ✅ Fetch the Family Head
        const resident = await db.collection("resident").findOne({ _id: residentId });

        if (!resident) {
            return res.status(404).send('<script>alert("Resident not found!"); window.location="/fml";</script>');
        }

        console.log("🔍 Resident (Head) Found:", resident);

        // ✅ Ensure `headId` is an ObjectId
        const familyMembers = await db.collection("resident").find({ 
            headId: residentId.toString()  // Convert ObjectId to String
        }).toArray();

        console.log(`👨‍👩‍👧 Family Members Found (${familyMembers.length}):`, familyMembers);

        res.render("fmlView", {
            layout: "layout",
            title: "Family Details",
            activePage: "fml",
            resident,
            familyMembers,
        });

    } catch (err) {
        console.error("❌ Error fetching family details:", err);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/fml";</script>');
    }
});

app.get("/rsdView/:id", isLogin, async (req, res) => {
    try {
        const residentId = new ObjectId(req.params.id);
        const resident = await db.collection("resident").findOne({ _id: residentId });

        if (!resident) {
            return res.status(404).send('<script>alert("Resident not found!"); window.location="/rsd";</script>');
        }

        const families = db.collection("family");
        const households = db.collection("household");

        let familyData = null;
        if (resident.familyId) {
            familyData = await families.findOne({ _id: new ObjectId(resident.familyId) });
        }

        // Fetch Household Details (entire document)
        let householdData = null;
        if (resident.householdId) {
            householdData = await households.findOne({ _id: new ObjectId(resident.householdId) });
        }

        // Fetch Family Members
        let familyMembers = [];
        if (resident.familyId) {
            familyMembers = await db.collection("resident").find({ familyId: resident.familyId }).toArray();
        
            // Calculate age for each family member
            familyMembers = familyMembers.map(member => {
                let age = "Age Unknown";
                if (member.bYear && member.bMonth && member.bDay) {
                    const birthDate = new Date(member.bYear, member.bMonth - 1, member.bDay);
                    const today = new Date();
                    
                    let years = today.getFullYear() - birthDate.getFullYear();
                    let months = today.getMonth() - birthDate.getMonth();
                    let days = today.getDate() - birthDate.getDate();
        
                    if (days < 0) {
                        months--; // Adjust if days are negative
                        days += new Date(today.getFullYear(), today.getMonth(), 0).getDate(); // Get last month's days
                    }
                    if (months < 0) {
                        years--; // Adjust if months are negative
                        months += 12;
                    }
        
                    if (years < 1) {
                        if (months === 0) {
                            age = "Less than a month old";
                        } else {
                            age = `${months} Month${months > 1 ? "s" : ""} Old`;
                        }
                    } else {
                        age = `${years} Year${years > 1 ? "s" : ""} Old`;
                    }
                }
                return { ...member, age };
            });
        }
        

        // Calculate Age and Format Birthday
        let age = "--";
        let birthday = "--";
        
        if (resident.bYear && resident.bMonth && resident.bDay) {
            const birthDate = new Date(resident.bYear, resident.bMonth - 1, resident.bDay);
            const today = new Date();
        
            const diffInMilliseconds = today - birthDate;
            const diffInDays = Math.floor(diffInMilliseconds / (1000 * 60 * 60 * 24));
            const diffInMonths = Math.floor(diffInDays / 30.44); // Average days in a month
            const diffInYears = Math.floor(diffInMonths / 12);
        
            if (diffInDays < 30) {
                age = "Less than a Month";
            } else if (diffInMonths < 12) {
                age = `${diffInMonths} ${diffInMonths === 1 ? "month old" : "months old"}`;
            } else {
                age = `${diffInYears} ${diffInYears === 1 ? "year old" : "years old"}`;
            }
        
            const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
            birthday = `${monthNames[resident.bMonth - 1]} ${resident.bDay}, ${resident.bYear}`;
        }

        familyMembers.sort((a, b) => {
            const ageA = parseInt(a.age) || 0; // Convert "29 Years Old" to 29
            const ageB = parseInt(b.age) || 0;
            return ageB - ageA; // Descending order
        });
        

        // Fetch Resident's Requests & Documents
        const requests = await db.collection("request").find({ requestBy: residentId, archive: { $in: [0, "0"] } }).toArray();
        const requestIds = requests.map(req => req._id);
        const documents = requestIds.length ? await db.collection("document").find({ reqId: { $in: requestIds } }).toArray() : [];

        // Fetch Complainee Records where resident is a complainee
        const complaineeRecords = await db.collection("complainees").find({ residentId: residentId }).toArray();
        const caseIds = complaineeRecords.map(c => new ObjectId(c.caseId));

        // Fetch Cases related to the resident as a complainee
        const cases = caseIds.length ? await db.collection("cases").find({ _id: { $in: caseIds } }).toArray() : [];

        // Fetch Complainants from the matched cases
        const complainants = caseIds.length ? await db.collection("complainants").find({ caseId: { $in: caseIds } }).toArray() : [];

        // Fetch Schedules related to these cases
        const schedules = caseIds.length ? await db.collection("schedule").find({ caseId: { $in: caseIds } }).toArray() : [];

        res.render("rsdView", {
            layout: "layout",
            title: "Resident Details",
            activePage: "rsd",
            resident,
            requests,
            documents,
            cases,
            schedules,
            complainants,
            complainees: complaineeRecords,
            familyData,  // ✅ Added Poverty Level
            householdData,  // ✅ Now passing the entire household data
            familyMembers,  // ✅ Passing all residents with the same familyId
            age,            // ✅ Added Age
            birthday,        // ✅ Added Birthday
            back: "rsd"
        });

    } catch (err) {
        console.error("❌ Error fetching resident details:", err);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/rsd";</script>');
    }
});


app.get("/rsdView3/:id", isLogin, async (req, res) => {
    try {
        const residentId = new ObjectId(req.params.id);
        const resident = await db.collection("resident").findOne({ _id: residentId });

        if (!resident) {
            return res.status(404).send('<script>alert("Resident not found!"); window.location="/rsd";</script>');
        }

        const families = db.collection("family");
        const households = db.collection("household");

        // Fetch Family Poverty Level

        let familyData = null;
        if (resident.familyId) {
            familyData = await families.findOne({ _id: new ObjectId(resident.familyId) });
        }

        // Fetch Household Details (entire document)
        let householdData = null;
        if (resident.householdId) {
            householdData = await households.findOne({ _id: new ObjectId(resident.householdId) });
        }

        // Fetch Family Members
        let familyMembers = [];
        if (resident.familyId) {
            familyMembers = await db.collection("resident").find({ familyId: resident.familyId }).toArray();
        
            // Calculate age for each family member
            familyMembers = familyMembers.map(member => {
                let age = "Age Unknown";
                if (member.bYear && member.bMonth && member.bDay) {
                    const birthDate = new Date(member.bYear, member.bMonth - 1, member.bDay);
                    const today = new Date();
                    
                    let years = today.getFullYear() - birthDate.getFullYear();
                    let months = today.getMonth() - birthDate.getMonth();
                    let days = today.getDate() - birthDate.getDate();
        
                    if (days < 0) {
                        months--; // Adjust if days are negative
                        days += new Date(today.getFullYear(), today.getMonth(), 0).getDate(); // Get last month's days
                    }
                    if (months < 0) {
                        years--; // Adjust if months are negative
                        months += 12;
                    }
        
                    if (years < 1) {
                        if (months === 0) {
                            age = "Less than a month old";
                        } else {
                            age = `${months} Month${months > 1 ? "s" : ""} Old`;
                        }
                    } else {
                        age = `${years} Year${years > 1 ? "s" : ""} Old`;
                    }
                }
                return { ...member, age };
            });
        }
        

        // Calculate Age and Format Birthday
        let age = "--";
        let birthday = "--";
        
        if (resident.bYear && resident.bMonth && resident.bDay) {
            const birthDate = new Date(resident.bYear, resident.bMonth - 1, resident.bDay);
            const today = new Date();
        
            const diffInMilliseconds = today - birthDate;
            const diffInDays = Math.floor(diffInMilliseconds / (1000 * 60 * 60 * 24));
            const diffInMonths = Math.floor(diffInDays / 30.44); // Average days in a month
            const diffInYears = Math.floor(diffInMonths / 12);
        
            if (diffInDays < 30) {
                age = "Less than a Month";
            } else if (diffInMonths < 12) {
                age = `${diffInMonths} ${diffInMonths === 1 ? "month old" : "months old"}`;
            } else {
                age = `${diffInYears} ${diffInYears === 1 ? "year old" : "years old"}`;
            }
        
            const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
            birthday = `${monthNames[resident.bMonth - 1]} ${resident.bDay}, ${resident.bYear}`;
        }

        familyMembers.sort((a, b) => {
            const ageA = parseInt(a.age) || 0; // Convert "29 Years Old" to 29
            const ageB = parseInt(b.age) || 0;
            return ageB - ageA; // Descending order
        });
        

        // Fetch Resident's Requests & Documents
        const requests = await db.collection("request").find({ requestBy: residentId, archive: { $in: [0, "0"] } }).toArray();
        const requestIds = requests.map(req => req._id);
        const documents = requestIds.length ? await db.collection("document").find({ reqId: { $in: requestIds } }).toArray() : [];

        // Fetch Complainee Records where resident is a complainee
        const complaineeRecords = await db.collection("complainees").find({ residentId: residentId }).toArray();
        const caseIds = complaineeRecords.map(c => new ObjectId(c.caseId));

        // Fetch Cases related to the resident as a complainee
        const cases = caseIds.length ? await db.collection("cases").find({ _id: { $in: caseIds } }).toArray() : [];

        // Fetch Complainants from the matched cases
        const complainants = caseIds.length ? await db.collection("complainants").find({ caseId: { $in: caseIds } }).toArray() : [];

        // Fetch Schedules related to these cases
        const schedules = caseIds.length ? await db.collection("schedule").find({ caseId: { $in: caseIds } }).toArray() : [];

        res.render("rsdView", {
            layout: "layout",
            title: "Resident Details",
            activePage: "rsd",
            resident,
            requests,
            documents,
            cases,
            schedules,
            complainants,
            complainees: complaineeRecords,
            familyData,  // ✅ Added Poverty Level
            householdData,  // ✅ Now passing the entire household data
            familyMembers,  // ✅ Passing all residents with the same familyId
            age,            // ✅ Added Age
            birthday,        // ✅ Added Birthday
            back: "rsdArc"
        });

    } catch (err) {
        console.error("❌ Error fetching resident details:", err);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/rsd";</script>');
    }
});



app.get("/rsdView2/:id", isLogin, async (req, res) => {
    try {
        const residentId = new ObjectId(req.params.id);
        const resident = await db.collection("resident").findOne({ _id: residentId });

        if (!resident) {
            return res.status(404).send('<script>alert("Resident not found!"); window.location="/rsd";</script>');
        }

        const families = db.collection("family");
        const households = db.collection("household");

        // Fetch Family Poverty Level
        let familyPoverty = "Unidentified Status";
        if (resident.familyId) {
            const family = await families.findOne({ _id: new ObjectId(resident.familyId) });
            if (family) {
                familyPoverty = family.poverty || "Unidentified Status";
            }
        }

        // Fetch Household Details (entire document)

        let familyData = null;
        if (resident.familyId) {
            familyData = await families.findOne({ _id: new ObjectId(resident.familyId) });
        }

        // Fetch Household Details (entire document)
        let householdData = null;
        if (resident.householdId) {
            householdData = await households.findOne({ _id: new ObjectId(resident.householdId) });
        }

        // Fetch Family Members
        let familyMembers = [];
        if (resident.familyId) {
            familyMembers = await db.collection("resident").find({ familyId: resident.familyId }).toArray();
        
            // Calculate age for each family member
            familyMembers = familyMembers.map(member => {
                let age = "Age Unknown";
                if (member.bYear && member.bMonth && member.bDay) {
                    const birthDate = new Date(member.bYear, member.bMonth - 1, member.bDay);
                    const today = new Date();
                    
                    let years = today.getFullYear() - birthDate.getFullYear();
                    let months = today.getMonth() - birthDate.getMonth();
                    let days = today.getDate() - birthDate.getDate();
        
                    if (days < 0) {
                        months--; // Adjust if days are negative
                        days += new Date(today.getFullYear(), today.getMonth(), 0).getDate(); // Get last month's days
                    }
                    if (months < 0) {
                        years--; // Adjust if months are negative
                        months += 12;
                    }
        
                    if (years < 1) {
                        if (months === 0) {
                            age = "Less than a month old";
                        } else {
                            age = `${months} Month${months > 1 ? "s" : ""} Old`;
                        }
                    } else {
                        age = `${years} Year${years > 1 ? "s" : ""} Old`;
                    }
                }
                return { ...member, age };
            });
        }
        

        // Calculate Age and Format Birthday
        let age = "--";
        let birthday = "--";
        
        if (resident.bYear && resident.bMonth && resident.bDay) {
            const birthDate = new Date(resident.bYear, resident.bMonth - 1, resident.bDay);
            const today = new Date();
        
            const diffInMilliseconds = today - birthDate;
            const diffInDays = Math.floor(diffInMilliseconds / (1000 * 60 * 60 * 24));
            const diffInMonths = Math.floor(diffInDays / 30.44); // Average days in a month
            const diffInYears = Math.floor(diffInMonths / 12);
        
            if (diffInDays < 30) {
                age = "Less than a Month";
            } else if (diffInMonths < 12) {
                age = `${diffInMonths} ${diffInMonths === 1 ? "month old" : "months old"}`;
            } else {
                age = `${diffInYears} ${diffInYears === 1 ? "year old" : "years old"}`;
            }
        
            const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
            birthday = `${monthNames[resident.bMonth - 1]} ${resident.bDay}, ${resident.bYear}`;
        }

        familyMembers.sort((a, b) => {
            const ageA = parseInt(a.age) || 0; // Convert "29 Years Old" to 29
            const ageB = parseInt(b.age) || 0;
            return ageB - ageA; // Descending order
        });
        

        // Fetch Resident's Requests & Documents
        const requests = await db.collection("request").find({ requestBy: residentId, archive: { $in: [0, "0"] } }).toArray();
        const requestIds = requests.map(req => req._id);
        const documents = requestIds.length ? await db.collection("document").find({ reqId: { $in: requestIds } }).toArray() : [];

        // Fetch Complainee Records where resident is a complainee
        const complaineeRecords = await db.collection("complainees").find({ residentId: residentId }).toArray();
        const caseIds = complaineeRecords.map(c => new ObjectId(c.caseId));

        // Fetch Cases related to the resident as a complainee
        const cases = caseIds.length ? await db.collection("cases").find({ _id: { $in: caseIds } }).toArray() : [];

        // Fetch Complainants from the matched cases
        const complainants = caseIds.length ? await db.collection("complainants").find({ caseId: { $in: caseIds } }).toArray() : [];

        // Fetch Schedules related to these cases
        const schedules = caseIds.length ? await db.collection("schedule").find({ caseId: { $in: caseIds } }).toArray() : [];

        res.render("rsdView", {
            layout: "layout",
            title: "Resident Details",
            activePage: "rsd",
            resident,
            requests,
            documents,
            cases,
            schedules,
            complainants,
            complainees: complaineeRecords,
            familyData,  // ✅ Added Poverty Level
            householdData,  // ✅ Now passing the entire household data
            familyMembers,  // ✅ Passing all residents with the same familyId
            age,            // ✅ Added Age
            birthday ,       // ✅ Added Birthday
            back: "hsh"
        });

    } catch (err) {
        console.error("❌ Error fetching resident details:", err);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/rsd";</script>');
    }
});


app.post("/cmpNew", async (req, res) => {
    try {
        const { caseNo, complainants, complainees, type, month, day, year, hour, minute, zone } = req.body;

        // Parse complainees from JSON format
        const complaineesArray = JSON.parse(complainees);

        // Insert a new case in "cases" collection with manually inputted caseNo
        const newCase = await db.collection("cases").insertOne({
            caseNo: caseNo, // Manually inputted case number
            type: type,
            status: "Pending",
            month: month,
            day: day,
            year: year,
            hour: hour,
            minute: minute,
            zone: zone,
            archive: 0, // ✅ Added archive field set to 0
            createdAt: new Date()
        });

        // Get the generated case ID
        const caseId = newCase.insertedId;

        // Insert complainants into "complainants" collection
        await db.collection("complainants").insertOne({
            caseId: caseId,
            name: complainants, // Array of complainant names
            createdAt: new Date()
        });

        // Insert complainees into "complainees" collection
        await db.collection("complainees").insertOne({
            caseId: caseId,
            name: complaineesArray, // Array of selected resident _id values
            createdAt: new Date()
        });

        res.redirect("/cmp"); // Redirect to complaints list after submission
    } catch (err) {
        console.error("Error adding complaint:", err);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/cmpNew";</script>');
    }
});

app.post("/arcCase/:id", async (req, res) => { 
    try {
        const caseId = req.params.id;
        if (!ObjectId.isValid(caseId)) return res.status(400).send("Invalid case ID");

        const caseObjectId = new ObjectId(caseId);
        const casesCollection = db.collection("cases");

        const updateResult = await casesCollection.updateOne(
            { _id: caseObjectId },
            { $set: { archive: 1 } }
        );

        if (updateResult.modifiedCount === 0) return res.status(404).send("Case not found.");

        res.redirect("/cmp");  
    } catch (error) {
        console.error("Error archiving case:", error);
        res.status(500).send("Internal Server Error");
    }
});

app.get("/export-residents-pdf", async (req, res) => {
    try {
        const residents = await db.collection("resident").find().toArray();
        const doc = new PDFDocument({ margin: 50 });
        const fileName = `Residents_Report_${Date.now()}.pdf`;
        const filePath = path.join(__dirname, "public", "reports", fileName);

        if (!fs.existsSync(path.join(__dirname, "public", "reports"))) {
            fs.mkdirSync(path.join(__dirname, "public", "reports"), { recursive: true });
        }

        const writeStream = fs.createWriteStream(filePath);
        doc.pipe(writeStream);

        // Title
        doc.fontSize(20).fillColor("#1F4E79").text("Residents Report", { align: "center" }).moveDown(2);

        // Categorization
        const ageGroups = {
            "0-5 Months": [],
            "6-11 Months": [],
            "1-5 Years Old": [],
            "6-12 Years Old": [],
            "13-17 Years Old": [],
            "18-59 Years Old": [],
            "15-30 (SK Voters)": [],
            "59 & Above (Senior Citizen)": []
        };
        
        const genderGroups = { Male: [], Female: [], Other: [] };
        const priorityGroups = {};

        residents.forEach(r => {
            const age = calculateAge(r.bMonth, r.bDay, r.bYear);
            
            if (age < 1) {
                const monthsOld = moment().diff(`${r.bYear}-${r.bMonth}-${r.bDay}`, "months");
                if (monthsOld <= 5) ageGroups["0-5 Months"].push(r);
                else ageGroups["6-11 Months"].push(r);
            } else if (age >= 1 && age <= 5) ageGroups["1-5 Years Old"].push(r);
            else if (age >= 6 && age <= 12) ageGroups["6-12 Years Old"].push(r);
            else if (age >= 13 && age <= 17) ageGroups["13-17 Years Old"].push(r);
            else if (age >= 18 && age <= 59) ageGroups["18-59 Years Old"].push(r);
            if (age >= 15 && age <= 30) ageGroups["15-30 (SK Voters)"].push(r);
            if (age >= 59) ageGroups["59 & Above (Senior Citizen)"].push(r);

            // Gender Grouping
            const genderKey = r.gender?.toLowerCase() === "male" ? "Male" : r.gender?.toLowerCase() === "female" ? "Female" : "Other";
            genderGroups[genderKey].push(r);

            // Priority Grouping
            if (r.priority) {
                if (!priorityGroups[r.priority]) {
                    priorityGroups[r.priority] = [];
                }
                priorityGroups[r.priority].push(r);
            }
        });

        function addCategorySection(title, group) {
            doc.fontSize(16).fillColor("#1F4E79").text(title).moveDown(0.5);
            doc.fillColor("#000000").fontSize(12);
            Object.keys(group).forEach(category => {
                doc.fontSize(14).text(`${category}: ${group[category].length} residents`).moveDown(0.3);
            });
            doc.moveDown(1);
        }

        // Add Sections
        addCategorySection("Age Distribution", ageGroups);
        addCategorySection("Gender Distribution", genderGroups);
        addCategorySection("Priority Groups", priorityGroups);

        // Finalize PDF
        doc.end();

        writeStream.on("finish", () => {
            res.download(filePath, fileName, (err) => {
                if (err) console.error("❌ Error downloading PDF:", err);
                fs.unlinkSync(filePath); // Delete file after download
            });
        });
    } catch (error) {
        console.error("❌ Error exporting residents as PDF:", error);
        res.status(500).json({ message: "Error exporting residents data." });
    }
});

function calculateAge(bMonth, bDay, bYear) {
    if (!bMonth || !bDay || !bYear) return 0;
    const monthNumber = isNaN(bMonth) ? moment().month(bMonth).format("M") : bMonth;
    return moment().diff(`${bYear}-${monthNumber}-${bDay}`, "years");
}

app.get("/rpt", isLogin, isRsd, async (req, res) => {
    try {
        const residents = await db.collection("resident").find().toArray();
        const households = await db.collection("household").find().toArray();
        const families = await db.collection("family").find().toArray();

        // Make lookup maps for faster matching
        const householdMap = households.reduce((map, h) => {
            map[h._id.toString()] = h;
            return map;
        }, {});

        const familyMap = families.reduce((map, f) => {
            map[f._id.toString()] = f;
            return map;
        }, {});

        // Filter out archived residents (only archive = 0 or "0")
        const activeResidents = residents.filter(r => r.archive === 0 || r.archive === "0");

        // Process residents
        const processedResidents = activeResidents.map(resident => {
            const age = calculateAge(resident.bMonth, resident.bDay, resident.bYear);

            // Find related household and family
            const household = householdMap[resident.householdId?.toString()] || null;
            const family = familyMap[resident.familyId?.toString()] || null;

            return {
                ...resident,
                fullName: `${resident.firstName} ${resident.middleName || ""} ${resident.lastName} ${resident.extName || ""}`.trim(),
                address: `${resident.houseNo || "No Record"}, Purok ${resident.purok || "No Record"}`,
                age: age,
                isSenior: age >= 60 ? "Yes" : "-",
                isSKVoter: age >= 15 && age <= 30 ? "Yes" : "-",
                isPWD: resident.pwd === "on" ? "Yes" : "-",
                soloP: resident.soloParent === "on" ? "Yes" : "-",
                household: household, 
                family: family
            };
        });

        res.render("rpt", { 
            residents: processedResidents, 
            layout: "layout", 
            title: "Report", 
            activePage: "dsb" 
        });
    } catch (error) {
        console.error("❌ Error fetching residents:", error);
        res.status(500).send("Error loading residents report.");
    }
});


app.get("/rptTest", isLogin, isRsd, async (req, res) => {
    try {
        const residents = await db.collection("resident").find().toArray();
        const households = await db.collection("household").find().toArray();
        const families = await db.collection("family").find().toArray();

        // Make lookup maps for faster matching
        const householdMap = households.reduce((map, h) => {
            map[h._id.toString()] = h;
            return map;
        }, {});

        const familyMap = families.reduce((map, f) => {
            map[f._id.toString()] = f;
            return map;
        }, {});

        // Filter out archived residents (only archive = 0 or "0")
        const activeResidents = residents.filter(r => r.archive === 0 || r.archive === "0");

        // Process residents
        const processedResidents = activeResidents.map(resident => {
            const age = calculateAge(resident.bMonth, resident.bDay, resident.bYear);

            // Find related household and family
            const household = householdMap[resident.householdId?.toString()] || null;
            const family = familyMap[resident.familyId?.toString()] || null;

            return {
                ...resident,
                fullName: `${resident.firstName} ${resident.middleName || ""} ${resident.lastName} ${resident.extName || ""}`.trim(),
                address: `${resident.houseNo || "No Record"}, Purok ${resident.purok || "No Record"}`,
                age: age,
                isSenior: age >= 60 ? "Yes" : "-",
                isSKVoter: age >= 15 && age <= 30 ? "Yes" : "-",
                isPWD: resident.pwd === "on" ? "Yes" : "-",
                soloP: resident.soloParent === "on" ? "Yes" : "-",
                household: household, 
                family: family
            };
        });

        res.render("rptTest", { 
            residents: processedResidents, 
            layout: "layout", 
            title: "Report", 
            activePage: "dsb" 
        });
    } catch (error) {
        console.error("❌ Error fetching residents:", error);
        res.status(500).send("Error loading residents report.");
    }
});


// Function to calculate age
function calculateAge(bMonth, bDay, bYear) {
    if (!bMonth || !bDay || !bYear) return 0;
    const monthNumber = isNaN(bMonth) ? moment().month(bMonth).format("M") : bMonth;
    return moment().diff(`${bYear}-${monthNumber}-${bDay}`, "years");
}

app.post("/rst/:id", async (req, res) => {
    try {
        const userId = req.params.id;
        const { newPassword, confirmPassword } = req.body;

        if (!newPassword || !confirmPassword) {
            return res.send('<script>alert("Please fill in all fields."); window.history.back();</script>');
        }

        if (newPassword !== confirmPassword) {
            return res.send('<script>alert("Passwords do not match."); window.history.back();</script>');
        }

        // Update the password and delete the reset field
        await db.collection("resident").updateOne(
            { _id: new ObjectId(userId) },
            { 
                $set: { password: newPassword }, 
                $unset: { reset: 1 } // Removes the 'reset' field completely
            }
        );

        return res.send('<script>alert("Password successfully reset. Please log in."); window.location="/";</script>');

    } catch (error) {
        console.error("Error resetting password:", error);
        res.send('<script>alert("An error occurred. Please try again later."); window.location="/";</script>');
    }
});

app.put("/update-indigent/:id", async (req, res) => {
    try {
        const { id } = req.params;
        const { indigent } = req.body;

        const objectId = new ObjectId(id);

        // Update the resident's indigent status
        await db.collection("resident").updateOne(
            { _id: objectId },
            { $set: { indigent: indigent } }
        );

        // Update all dependents with the same headId to match the new status
        await db.collection("resident").updateMany(
            { headId: objectId },
            { $set: { indigent: indigent } }
        );

        res.json({ success: true });
    } catch (error) {
        console.error("Update Error:", error);
        res.status(500).json({ success: false });
    }
});


app.get("/newRsd", isLogin, isRsd, (req, res) => res.render("newRsd", { layout: "layout", title: "New Resident", activePage: "newRsd" }));

app.get('/check-resident', async (req, res) => {
    try {
        const { houseNo, purok } = req.query;

        if (!houseNo || !purok) {
            return res.json({ exists: false });
        }

        // Check in household collection where archive is 0 or "0"
        const householdExists = await db.collection("household").findOne({
            archive: { $in: [0, "0"] }, 
            houseNo: houseNo,  // Exact match for house number
            purok: new RegExp(`^${purok}$`, "i") // Case-insensitive exact match for purok
        });

        res.json({ exists: !!householdExists });
    } catch (error) {
        console.error("Error checking household:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});


app.post("/add-household", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, message: "Database not connected" });
        }

        const householdCollection = db.collection("household");
        const householdData = req.body;
        householdData.archive = "0";

        const result = await householdCollection.insertOne(householdData);

        if (result.insertedId) {
            res.redirect(`/hshSuccess/${result.insertedId}`);
        } else {
            res.status(500).json({ success: false, message: "Failed to add household" });
        }
    } catch (error) {
        console.error("Insert Error:", error);
        res.status(500).json({ success: false, message: "Error inserting household" });
    }
});

app.get("/hshSuccess/:id", isLogin, (req, res) => {
    const { id } = req.params;
    res.render("hshSuccess", { id, 
            layout: "layout",
            title: `Household Details`,
            activePage: "hsh" });
});
app.get("/hshView/:id", isLogin, isRsd, async (req, res) => {
    try {
        if (!db) {
            return res.status(500).send("Database not connected");
        }

        const { id } = req.params;
        const householdCollection = db.collection("household");
        const familiesCollection = db.collection("family");
        const residentsCollection = db.collection("resident");
        const { ObjectId } = require("mongodb");

        // Find household by _id (ObjectId only, since _id should be ObjectId)
        const household = await householdCollection.findOne({ _id: new ObjectId(id) });

        if (!household) {
            return res.status(404).send("Household not found");
        }

        // Fetch families under this household (householdId may be string or ObjectId)
        const families = await familiesCollection
            .find({
                householdId: { $in: [id, new ObjectId(id)] },
                archive: { $in: ["0", 0] }
            })
            .toArray();

        // Fetch residents for each family
        for (let family of families) {
            family.residents = await residentsCollection
                .find({
                    familyId: { $in: [family._id.toString(), new ObjectId(family._id)] },
                    archive: { $in: ["0", 0] }
                })
                .toArray();

            // Add Age Calculation
            family.residents = family.residents.map(resident => {
                let age = "Age Unknown";
                if (resident.bYear && resident.bMonth && resident.bDay) {
                    const birthDate = new Date(resident.bYear, resident.bMonth - 1, resident.bDay);
                    const today = new Date();
                    let years = today.getFullYear() - birthDate.getFullYear();
                    const m = today.getMonth() - birthDate.getMonth();
                    if (m < 0 || (m === 0 && today.getDate() < birthDate.getDate())) {
                        years--;
                    }
                    age = `${years} Year${years > 1 ? "s" : ""} Old`;
                }
                return { ...resident, age };
            }).sort((a, b) => {
                return parseInt(b.age) - parseInt(a.age); // Eldest first
            });

            // Poverty Status Logic
            let totalIncome = family.residents.reduce((sum, res) => sum + (Number(res.monthlyIncome) || 0), 0);
            let familySize = family.residents.length;

            let povertyStatus = "Non-Indigent";
            if (familySize >= 1 && familySize <= 2) {
                if (totalIncome < 7500) povertyStatus = "Indigent";
                else if (totalIncome <= 10000) povertyStatus = "Low Income";
            } else if (familySize >= 3 && familySize <= 4) {
                if (totalIncome < 10000) povertyStatus = "Indigent";
                else if (totalIncome <= 13000) povertyStatus = "Low Income";
            } else if (familySize >= 5 && familySize <= 6) {
                if (totalIncome < 12500) povertyStatus = "Indigent";
                else if (totalIncome <= 15000) povertyStatus = "Low Income";
            } else if (familySize >= 7 && familySize <= 8) {
                if (totalIncome < 15000) povertyStatus = "Indigent";
                else if (totalIncome <= 18000) povertyStatus = "Low Income";
            } else if (familySize >= 9) {
                if (totalIncome < 17000) povertyStatus = "Indigent";
                else if (totalIncome <= 20000) povertyStatus = "Low Income";
            }

            family.poverty = povertyStatus;
        }

        res.render("hshView", {
            household,
            families,
            layout: "layout",
            title: `Household Details`,
            activePage: "hsh"
        });
    } catch (error) {
        console.error("Fetch Error:", error);
        res.status(500).send("Error fetching household details");
    }
});



app.get("/hshUpdate/:id", isLogin, isRsd, async (req, res) => {
    try {
        if (!db) {
            return res.status(500).send("Database not connected");
        }

        const { id } = req.params;
        const householdCollection = db.collection("household");
        const familiesCollection = db.collection("family");
        const residentsCollection = db.collection("resident");
        const { ObjectId } = require("mongodb");

        // Find household by _id
        const household = await householdCollection.findOne({ _id: new ObjectId(id) });

        if (!household) {
            return res.status(404).send("Household not found");
        }

        // Fetch families under this household (archive must be "0" or 0)
        const families = await familiesCollection
            .find({ householdId: id, archive: { $in: ["0", 0] } })
            .toArray();

        // Fetch residents for each family
        for (let family of families) {
            family.residents = await residentsCollection
                .find({ familyId: new ObjectId(family._id), archive: { $in: ["0", 0] } }) 
                .toArray();

            // Poverty Status Logic
            let totalIncome = family.residents.reduce((sum, res) => sum + (Number(res.monthlyIncome) || 0), 0);
            let familySize = family.residents.length;

            let povertyStatus = "Non-Indigent";
            if (familySize >= 1 && familySize <= 2) {
                if (totalIncome < 7500) povertyStatus = "Indigent";
                else if (totalIncome <= 10000) povertyStatus = "Low Income";
            } else if (familySize >= 3 && familySize <= 4) {
                if (totalIncome < 10000) povertyStatus = "Indigent";
                else if (totalIncome <= 13000) povertyStatus = "Low Income";
            } else if (familySize >= 5 && familySize <= 6) {
                if (totalIncome < 12500) povertyStatus = "Indigent";
                else if (totalIncome <= 15000) povertyStatus = "Low Income";
            } else if (familySize >= 7 && familySize <= 8) {
                if (totalIncome < 15000) povertyStatus = "Indigent";
                else if (totalIncome <= 18000) povertyStatus = "Low Income";
            } else if (familySize >= 9) {
                if (totalIncome < 17000) povertyStatus = "Indigent";
                else if (totalIncome <= 20000) povertyStatus = "Low Income";
            }

            family.poverty = povertyStatus;
        }

        res.render("hshUpdate", {
            household,
            families, // Families with their respective residents and poverty status
            layout: "layout",
            title: `Household Details`,
            activePage: "hsh"
        });
    } catch (error) {
        console.error("Fetch Error:", error);
        res.status(500).send("Error fetching household details");
    }
});



app.get("/newFml/:householdId", isLogin, async (req, res) => {
    const { householdId } = req.params;

    // Example dropdown list for cities (you can fetch from a database)
    const cities = ["Science City of Muñoz", "Cabanatuan", "Talavera", "San Jose", "Quezon"];

    // Example disability types
    const pwdTypes = ["Visual Impairment", "Hearing Impairment", "Mobility Impairment", "Intellectual Disability"];

    res.render("newFml", { householdId, cities, pwdTypes, layout: "Layout", title: 'New Family', activePage: "hsh" });
});


function generateUsername(firstName, middleName, lastName, bDay, bYear) {
    if (!firstName || !middleName || !lastName) return null;
    return `${firstName.charAt(0)}${firstName.slice(-1)}${middleName.charAt(0)}${middleName.slice(-1)}.${lastName}${bDay}${bYear.slice(-2)}`.toLowerCase();
}

app.post("/add-family", async (req, res) => {
    try {
        const residents = db.collection("resident");
        const families = db.collection("family"); // Collection for family data

        const { 
            firstName, middleName, lastName, extName, birthPlace, // Added fields
            bMonth, bDay, bYear, gender, civilStatus, pregnant, precinct, phone, email, 
            soloParent, pwd, pwdType, employmentStatus, work, monthlyIncome, position, householdId, rel // Added rel field
        } = req.body;

        // Calculate age
        const birthDate = new Date(`${bYear}-${bMonth}-${bDay}`);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        if (today.getMonth() < birthDate.getMonth() || (today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate())) {
            age--;
        }

        if (age < 15) {
            return res.status(400).json({ message: "Family Head can't be a minor" });
        }

        let username = null;
        let password = null;
        if (age >= 15 && age <= 59) {
            username = generateUsername(firstName, middleName, lastName, bDay, bYear);
            password = generateRandomPassword();
        }

        // Determine resident access level
        const privilegedPositions = ["Barangay Secretary", "Punong Barangay", "Barangay Worker", "BWDO", "Barangay Clerk"];
        const access = privilegedPositions.includes(position) ? 1 : 0;

        // Convert monthlyIncome to number
        const income = monthlyIncome ? parseFloat(monthlyIncome) : 0;

        // Determine poverty level for 1-2 members
        let poverty = "Non-Indigent"; // Default
        if (income < 7500) {
            poverty = "Indigent";
        } else if (income >= 7500 && income <= 10000) {
            poverty = "Low Income";
        }

        // Create a new family document
        const newFamily = {
            familyIncome: income,
            poverty, // Determined based on income
            archive: 0,
            updatedAt: new Date(),
            createdAt: new Date(),
            householdId,
        };

        // Insert into the `family` collection and get the newly created _id
        const familyResult = await families.insertOne(newFamily);
        const familyId = familyResult.insertedId; // Get the newly created family's _id

        // Create the resident document with familyId and householdId
        const newResident = {
            firstName, middleName, lastName, extName, birthPlace, // Included the new fields
            bMonth, bDay, bYear, gender, civilStatus, pregnant, precinct, phone, email,
            soloParent, pwd, pwdType, employmentStatus, work, monthlyIncome: income, position,
            archive: 0,
            reset: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            successAt: null,
            username,
            password,
            role: "Head", // Assign role as Head
            familyId, // Link the resident to the newly created family
            householdId, // ✅ Added householdId
            access, // Set access level
            rel // ✅ Added rel field
        };

        await residents.insertOne(newResident);

        // ✅ Redirect to household view after success
        res.redirect(`/hshView/${householdId}`);
    } catch (error) {
        console.error("Error adding resident:", error);
        res.status(500).send('<script>alert("Error adding resident"); window.location="/";</script>');
    }
});



app.get("/newMem/:familyId", isLogin, async (req, res) => {
    const { familyId } = req.params;
    const { householdId } = req.query; // Extract householdId from query params

    res.render("newMem", { 
        familyId, 
        householdId, 
        layout: "Layout", 
        title: 'New Member', 
        activePage: "hsh" 
    });
});


app.get("/nonRes", isLogin, async (req, res) => {

    res.render("nonRes", {
        layout: "Layout", 
        title: 'New Member', 
        activePage: "rsd" 
    });
});

app.post("/add-member", async (req, res) => {
    try {
        const residents = db.collection("resident");
        const families = db.collection("family");

        const { 
            firstName, middleName, lastName, extName, birthPlace, 
            bMonth, bDay, bYear, gender, civilStatus, pregnant, precinct, phone, email, 
            soloParent, pwd, pwdType, employmentStatus, work, monthlyIncome, position, 
            householdId, familyId,
            birthHeight, birthWeight, healthCenter, // ✅ Added new fields
            rel // ✅ Added rel field
        } = req.body;

        // Ensure householdId and familyId are valid ObjectId instances
        if (!ObjectId.isValid(familyId) || !ObjectId.isValid(householdId)) {
            return res.status(400).json({ message: "Invalid householdId or familyId" });
        }

        const familyObjectId = new ObjectId(familyId);
        const householdObjectId = new ObjectId(householdId);

        // Calculate age
        const birthDate = new Date(`${bYear}-${bMonth}-${bDay}`);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        if (today.getMonth() < birthDate.getMonth() || (today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate())) {
            age--;
        }

        // Generate username & password only if age is between 15-59
        let username = null;
        let password = null;
        if (age >= 15 && age <= 59) {
            username = generateUsername(firstName, middleName, lastName, bDay, bYear);
            password = generateRandomPassword();
        }

        // Determine resident access level
        const privilegedPositions = ["Barangay Secretary", "Punong Barangay", "Barangay Worker", "BWDO", "Barangay Clerk"];
        const access = privilegedPositions.includes(position) ? 1 : 0;

        // Convert monthlyIncome to a number
        const income = monthlyIncome ? parseFloat(monthlyIncome) : 0;

        // Insert the new resident into the `resident` collection
        const newResident = {
            firstName, middleName, lastName, extName, birthPlace,
            bMonth, bDay, bYear, gender, civilStatus, pregnant, precinct, phone, email,
            soloParent, pwd, pwdType, employmentStatus, work, monthlyIncome: income, position,
            birthHeight, birthWeight, healthCenter, // ✅ Added new fields
            rel, // ✅ Added rel field
            archive: 0,
            reset: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            successAt: null,
            username,
            password,
            role: "Member",
            familyId: familyObjectId, // Link resident to existing family
            householdId: householdObjectId, // ✅ Added householdId
            access,
        };

        await residents.insertOne(newResident);

        // **Update familyIncome in the family collection**
        await families.updateOne(
            { _id: familyObjectId },
            { $inc: { familyIncome: income } } // Add resident's income to family's income
        );

        // **Redirect to household view after success**
        res.redirect(`/hshView/${householdObjectId}`);
    } catch (error) {
        console.error("Error adding resident:", error);
        res.status(500).send('<script>alert("Error adding resident"); window.location="/";</script>');
    }
});


app.post("/add-member2", async (req, res) => {
    try {
        const residents = db.collection("resident");
        const families = db.collection("family");

        const { 
            firstName, middleName, lastName, extName, birthPlace, 
            bMonth, bDay, bYear, gender, civilStatus, pregnant, precinct, phone, email, 
            soloParent, pwd, pwdType, employmentStatus, work, monthlyIncome, position, 
            householdId, familyId,
            birthHeight, birthWeight, healthCenter, // ✅ Added new fields
            rel // ✅ Added rel field
        } = req.body;

        // Calculate age
        const birthDate = new Date(`${bYear}-${bMonth}-${bDay}`);
        const today = new Date();
        let age = today.getFullYear() - birthDate.getFullYear();
        if (today.getMonth() < birthDate.getMonth() || (today.getMonth() === birthDate.getMonth() && today.getDate() < birthDate.getDate())) {
            age--;
        }

        // Determine resident access level
        const privilegedPositions = ["Barangay Secretary", "Punong Barangay", "Barangay Worker", "BWDO", "Barangay Clerk"];
        const access = privilegedPositions.includes(position) ? 0 : 0;

        // Convert monthlyIncome to a number
        const income = monthlyIncome ? parseFloat(monthlyIncome) : 0;

        // Insert the new resident into the `resident` collection
        const newResident = {
            firstName, middleName, lastName, extName, birthPlace,
            bMonth, bDay, bYear, gender, civilStatus, pregnant, precinct, phone, email,
            soloParent, pwd, pwdType, employmentStatus, work, monthlyIncome: income, position,
            birthHeight, birthWeight, healthCenter, // ✅ Added new fields
            rel, // ✅ Added rel field
            archive: 1,
            reset: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            successAt: null,
            visitor: 1,
            role: "Member",
            access,
        };

        await residents.insertOne(newResident);

        // **Redirect to household view after success**
        res.redirect(`rsd`);
    } catch (error) {
        console.error("Error adding resident:", error);
        res.status(500).send('<script>alert("Error adding resident"); window.location="/";</script>');
    }
});

app.post('/update-household', async (req, res) => {
    try {
        const db = client.db(); // Ensure we're always using the connected database
        const householdsCollection = db.collection('household');

        const householdId = req.body.householdId;
        console.log('Received householdId:', householdId); // Debugging

        if (!householdId) {
            return res.status(400).send('Invalid household ID.');
        }

        const updatedData = {
            houseNo: req.body.houseNo,
            purok: req.body.purok,
            ownership: req.body.ownership,
            houseType: req.body.houseType,
            wallMaterial: req.body.wallMaterial,
            roofMaterial: req.body.roofMaterial,
            flooringMaterial: req.body.flooringMaterial,
            toiletType: req.body.toiletType,
            waterSource: req.body.waterSource,
            numRooms: parseInt(req.body.numRooms, 10),
            electricity: req.body.electricity
        };

        const result = await householdsCollection.updateOne(
            { _id: new ObjectId(householdId) },
            { $set: updatedData }
        );

        if (result.modifiedCount > 0) {
            res.redirect(`/hshView/${householdId}`);
        } else {
            res.status(400).send('No changes were made or invalid ID.');
        }
    } catch (error) {
        console.error('Update error:', error);
        res.status(500).send('Server error. Please try again.');
    }
});

app.get("/search-resident", async (req, res) => {
    try {
        if (!db) {
            console.error("❌ Database connection not initialized.");
            return res.status(500).json({ error: "Database connection error." });
        }

        let query = req.query.q?.trim(); // Trim whitespace
        console.log("🔎 Received Query:", query);

        if (!query) {
            return res.status(400).json({ error: "Query parameter is required" });
        }

        console.log("🛠 Executing MongoDB Query...");

        // Search in `resident` collection
        let results = await db.collection("resident")
            .find({
                $or: [
                    { firstName: { $regex: query, $options: "i" } },
                    { middleName: { $regex: query, $options: "i" } },
                    { lastName: { $regex: query, $options: "i" } }
                ]
            })
            .limit(10) // Limit results for better performance
            .project({ firstName: 1, middleName: 1, lastName: 1 }) // Fetch only necessary fields
            .toArray();

        // Convert `_id` to string
        results = results.map(resident => ({
            ...resident,
            _id: resident._id, // Ensure `_id` is a string
        }));

        console.log("📋 Found Residents:", results.length, "matches");
        res.json(results);
    } catch (error) {
        console.error("❌ Error fetching residents:", error.message, error.stack);
        res.status(500).json({ error: error.message });
    }
});

app.post("/cases", async (req, res) => {
    try {
        const { caseNo, complainants: complainantsJSON, respondents: respondentsJSON, caseTypes: caseTypesJSON } = req.body;
        
        // Parse JSON data
        const complainants = JSON.parse(complainantsJSON);
        const respondents = JSON.parse(respondentsJSON);
        const caseTypes = JSON.parse(caseTypesJSON);

        // Validate required fields
        if (!caseNo || !complainants?.length || !respondents?.length || !caseTypes?.length) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        // Process residents (complainants and respondents)
        const processPerson = async (person) => {
            if (person.isManual) {
                // For manual entries, create new resident record
                const result = await db.collection("resident").insertOne({
                    firstName: person.firstName,
                    middleName: person.middleName,
                    lastName: person.lastName,
                    extName: person.extName,
                    archive: "1", // Mark as non-resident
                    createdAt: new Date(),
                    updatedAt: new Date()
                });
                return result.insertedId;
            } else {
                // For existing residents, use their ID
                return new ObjectId(person._id);
            }
        };

        // Process all complainants and respondents in parallel
        const [complainantIds, respondentIds] = await Promise.all([
            Promise.all(complainants.map(processPerson)),
            Promise.all(respondents.map(processPerson))
        ]);

        // Create the case record
        const caseData = {
            caseNo,
            status: "Pending",
            archive: "0",
            complainants: complainantIds,
            respondents: respondentIds,
            type: caseTypes,
            createdAt: new Date(),
            updatedAt: new Date()
        };

        const result = await db.collection("cases").insertOne(caseData);
        
        // Ensure status is also set to "Pending"
        await db.collection("cases").updateOne(
            { _id: result.insertedId },
            { $set: { status: "Pending" } }
        );

        res.redirect("/cmp");
    } catch (error) {
        console.error("Error creating case:", error);
        res.status(500).json({ error: "Internal Server Error", details: error.message });
    }
});

app.get('/check-case-number', async (req, res) => { // Renamed for clarity
    try {
        const { caseNo } = req.query; // Only expect caseNo

        if (!caseNo) {
            // If caseNo is empty, consider it as not existing for this check
            return res.json({ exists: false }); 
        }

        // Check in the 'cases' collection
        const caseExists = await db.collection("cases").findOne({
            caseNo: caseNo // Exact match for case number
        });

        res.json({ exists: !!caseExists }); // !! converts truthy/falsy to true/false
    } catch (error) {
        console.error("Error checking case number:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.get('/check-office', async (req, res) => { // Renamed for clarity
    try {
        const { office } = req.query; // Only expect caseNo

        if (!office) {
            return res.json({ exists: false }); 
        }

        const caseExists = await db.collection("hotline").findOne({
            office: office
        });

        res.json({ exists: !!caseExists });
    } catch (error) {
        console.error("Error checking case number:", error);
        res.status(500).json({ error: "Internal server error" });
    }
});

app.post("/verify-password", requireAuth, async (req, res) => {
    try {
        const { currentPassword } = req.body;
        const userId = req.session.userId;

        const user = await db.collection("resident").findOne({ _id: new ObjectId(userId) });

        if (!user) {
            return res.status(404).json({ valid: false, message: "User not found" });
        }

        if (user.password === currentPassword) {
            return res.json({ valid: true });
        } else {
            return res.json({ valid: false });
        }
    } catch (err) {
        console.error("❌ Error verifying password:", err);
        res.status(500).json({ valid: false });
    }
});

app.post("/generate-households", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, message: "Database not connected" });
        }

        const householdCollection = db.collection("household");
        const puroks = ["Dike", "Shortcut", "Maharlika Highway", "Perigola", "Cantarilla", "Bagong Daan"];
        const householdsToInsert = [];

        // Helper function to get a random item from an array
        const getRandomItem = (array) => array[Math.floor(Math.random() * array.length)];

        // Define random options for each field
        const ownershipOptions = ["Owned", "Rented", "Informal Settler", "Government Housing"];
        const houseTypeOptions = ["Makeshift", "Nipa Hut", "Semi Concrete", "Fully Concrete"];
        const wallMaterialOptions = ["Bamboo", "Wood", "Hollow Blocks", "Light Materials"];
        const roofMaterialOptions = ["Galvanized Iron", "Nipa", "Wood", "Light Materials"];
        const flooringMaterialOptions = ["Cemented", "Wood", "Bamboo", "Tiles"];
        const toiletTypeOptions = ["Open Pit", "Shared", "Private with Flush", "None"];
        const waterSourceOptions = ["Deep Well", "Pump", "Faucet", "Bottled Water"];
        const electricityOptions = ["Electricity", "Solar", "Caserole Lamp", "Candle", "Generator"];

        for (const purok of puroks) {
            for (let i = 1; i <= 20; i++) {
                const householdData = {
                    // Generate unique ID, MongoDB will handle this automatically
                    // The house number will be randomly assigned from 1 to 100 for variety
                    houseNo: (Math.floor(Math.random() * 100) + 1).toString(),
                    purok: purok,
                    ownership: getRandomItem(ownershipOptions),
                    houseType: getRandomItem(houseTypeOptions),
                    wallMaterial: getRandomItem(wallMaterialOptions),
                    roofMaterial: getRandomItem(roofMaterialOptions),
                    flooringMaterial: getRandomItem(flooringMaterialOptions),
                    toiletType: getRandomItem(toiletTypeOptions),
                    waterSource: getRandomItem(waterSourceOptions),
                    numRooms: Math.floor(Math.random() * 5) + 1, // Random number of rooms between 1 and 5
                    electricity: getRandomItem(electricityOptions),
                    archive: "0",
                    dump: "1"
                };
                householdsToInsert.push(householdData);
            }
        }

        const result = await householdCollection.insertMany(householdsToInsert);

        if (result.insertedCount === householdsToInsert.length) {
            res.status(200).json({ success: true, message: `Successfully added ${result.insertedCount} households.` });
        } else {
            res.status(500).json({ success: false, message: "Failed to add all households" });
        }
    } catch (error) {
        console.error("Bulk Insert Error:", error);
        res.status(500).json({ success: false, message: "Error in bulk household insertion" });
    }
});

app.post("/delete-archived-households", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, message: "Database not connected" });
        }

        const householdCollection = db.collection("household");

        // Delete all documents where 'archive' field is "3" or 3
        const result = await householdCollection.deleteMany({
            $or: [
                { dump: "1" },
                { dump: 1 }
            ]
        });

        if (result.deletedCount > 0) {
            res.status(200).json({ success: true, message: `Successfully deleted ${result.deletedCount} archived households.` });
        } else {
            res.status(200).json({ success: false, message: "No households with archive status '3' found to delete." });
        }
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ success: false, message: "Error deleting archived households" });
    }
});

function generateUsername(firstName, middleName, lastName, bDay, bYear) {
    const firstInitial = firstName ? firstName.charAt(0) : '';
    const middleInitial = middleName ? middleName.charAt(0) : '';
    const lastInitial = lastName ? lastName.charAt(0) : '';
    const day = bDay.toString().padStart(2, '0');
    const year = bYear.toString().slice(-2);
    return `${firstInitial}${middleInitial}${lastInitial}${day}${year}`.toLowerCase();
}

// Helper to get a random item from an array
const getRandomItem = (array) => array[Math.floor(Math.random() * array.length)];
const getRandomNumber = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

const femalePhotos = ["kaila.jpg", "bell.jpg", "cristine.jpg", "mikha.jpg", "nadine.jpg", "user5.jpg"];
const malePhotos = ["daniel.jpg", "ian.jpg", "piolo.jpg", "richard.jpg", "anthony.jpg"];
// --- New Route for Generating Families and Residents ---

app.post("/generate-families-for-households", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, message: "Database not connected" });
        }

        const householdsCollection = db.collection("household");
        const residentsCollection = db.collection("resident");
        const familiesCollection = db.collection("family");

        // Fetch all existing households
        const households = await householdsCollection.find({ archive: { $ne: "3" } }).toArray();

        const familiesToInsert = [];
        const residentsToInsert = [];
        let pregnantWomenCount = 0;
        const minimumPregnantWomen = 20;
        const birthPlaces = [
            "Alaminos", "Angeles", "Antipolo", "Bacolod", "Bacoor", "Bago", "Baguio",
            "Bais", "Balanga", "Batac", "Batangas City", "Bayawan", "Baybay", "Bayugan",
            "Biñan", "Bislig", "Bogo", "Borongan", "Bulacan", "Butuan", "Cabadbaran",
            "Cabanatuan", "Cabuyao", "Cadiz", "Cagayan de Oro", "Calaca", "Calamba",
            "Calapan", "Calbayog", "Caloocan", "Candon", "Canlaon", "Carcar", "Carmona",
            "Catbalogan", "Cauayan", "Cavite City", "Cebu City", "Cotabato City",
            "Dagupan", "Danao", "Dapitan", "Dasmariñas", "Davao City", "Digos",
            "Dipolog", "Dumaguete", "El Salvador", "Escalante", "Gapan", "General Santos",
            "General Trias", "Gingoog", "Guihulngan", "Himamaylan", "Ilagan", "Iligan",
            "Iloilo City", "Imus", "Iriga", "Isabela", "Kabankalan", "Kidapawan",
            "Koronadal", "La Carlota", "Lamitan", "Laoag", "Lapu-Lapu", "Las Piñas",
            "Legazpi", "Ligao", "Lipa", "Lucena", "Maasin", "Mabalacat", "Makati",
            "Malabon", "Malaybalay", "Malolos", "Mandaluyong", "Mandaue", "Manila",
            "Marawi", "Marikina", "Masbate City", "Mati", "Meycauayan", "Muñoz",
            "Muntinlupa", "Naga", "Navotas", "Olongapo", "Ormoc", "Oroquieta", "Ozamiz",
            "Pagadian", "Palayan", "Panabo", "Parañaque", "Pasay", "Pasig", "Passi",
            "Puerto Princesa", "Quezon City", "Roxas", "Sagay", "Samal", "San Carlos",
            "San Fernando", "San Jose", "San Jose del Monte", "San Pablo", "San Pedro",
            "Santa Rosa", "Santo Tomas", "Santiago", "Silay", "Sipalay", "Sorsogon City",
            "Surigao City", "Tabaco", "Tabuk", "Tacloban", "Tacurong", "Tagaytay",
            "Tagbilaran", "Taguig", "Tagum", "Talisay", "Tanauan", "Tandag", "Tangub",
            "Tanjay", "Tarlac City", "Tayabas", "Toledo", "Trece Martires", "Tuguegarao",
            "Urdaneta", "Valencia", "Valenzuela", "Victorias", "Vigan", "Zamboanga City"
        ];

        // Predefined options for randomization
        const firstNamesMale = [
        "Juan", "Jose", "Antonio", "Andres", "Pedro",
        "Manuel", "Carlos", "Francisco", "Ramon", "Vicente",
        "Alfonso", "Fernando", "Emilio", "Julio", "Ricardo",
        "Eduardo", "Roberto", "Santiago", "Dominic", "Benigno",
        "Enrique", "Crisanto", "Isidro", "Mariano", "Nicanor",
        "Teodoro", "Ignacio", "Anselmo", "Severino", "Eusebio",
        "Jesus", "Felipe", "Salvador", "Armando", "Rolando",
        "Cesar", "Ernesto", "Alberto", "Mario", "Oscar",
        "Daniel", "Patrick", "Mark", "Christian", "Joseph",
        "Paul", "Allan", "Noel", "Jerome", "Arnold"
        ];
        const firstNamesFemale = [
        "Maria", "Ana", "Carmen", "Teresa", "Cristina",
        "Rosario", "Josefina", "Dolores", "Lourdes", "Mercedes",
        "Remedios", "Victoria", "Beatriz", "Isabel", "Gloria",
        "Consuelo", "Soledad", "Leonora", "Amelia", "Estrella",
        "Catalina", "Aurora", "Graciela", "Luisa", "Marilou",
        "Ligaya", "Mabini", "Rosalinda", "Imelda", "Erlinda",
        "Virgie", "Fe", "Esperanza", "Charito", "Divina",
        "Jocelyn", "Corazon", "Rowena", "Vilma", "Norma",
        "Gemma", "Lorna", "Fely", "Chona", "Diana",
        "Shirley", "Marites", "Evangeline", "Precious", "Lovely"
        ];
        const lastNames = [
        // A
        "Abad", "Agbayani", "Agcaoili", "Alcantara", "Alonzo",
        "Alvarado", "Amador", "Andrada", "Angeles", "Aquino",
        "Aragon", "Arellano", "Arriola", "Asuncion", "Austria", "Avila",

        // B
        "Bacani", "Balagtas", "Balderrama", "Baltazar", "Banzon",
        "Basco", "Belmonte", "Benitez", "Bermudez", "Bernardo",
        "Bonifacio", "Borja", "Buan", "Buenaventura",

        // C
        "Cabrera", "Cabanban", "Calderon", "Camacho", "Canlas",
        "Capistrano", "Carandang", "Carpio", "Casas", "Castillo",
        "Castro", "Cayabyab", "Celis", "Cruz", "Cuenca",

        // D
        "Dagdag", "Dalisay", "De Castro", "De Guzman", "De la Cruz",
        "Del Mundo", "Dimaculangan", "Domingo", "Dumlao",

        // E
        "Enriquez", "Escobar", "Espino", "Espinosa", "Estrella", "Estrada",

        // F
        "Fernandez", "Flores", "Fontanilla", "Francisco",

        // G
        "Gamboa", "Garcia", "Gatchalian", "Gonzales", "Guerrero", "Gutierrez",

        // H
        "Hernandez", "Herrera", "Hilario", "Hosillos",

        // I
        "Ignacio", "Ilagan", "Infante", "Isidro",

        // J
        "Jacinto", "Javier", "Jimenez", "Joaquin",

        // L
        "Labastida", "Lacson", "Lagman", "Lansangan", "Legaspi",
        "Leonardo", "Lopez", "Lucero", "Lumibao",

        // M
        "Macaraeg", "Madlangbayan", "Magalong", "Magbanua", "Magno",
        "Mallari", "Manalili", "Manalo", "Manansala", "Mangahas",
        "Marcelo", "Mariano", "Martinez", "Matias", "Medina",
        "Mendoza", "Mercado", "Miranda", "Morales", "Munoz",

        // N
        "Natividad", "Navarro", "Nieves", "Nolasco", "Norona",

        // O
        "Obispo", "Ocampo", "Ochoa", "Olivarez", "Ong", "Ordoñez", "Ortega",

        // P
        "Padilla", "Pagsanghan", "Palacios", "Panganiban", "Panlilio",
        "Pascual", "Paterno", "Perez", "Pineda", "Ponce", "Portillo",

        // Q
        "Quejada", "Quijano", "Quimpo", "Quirino",

        // R
        "Ramos", "Ramirez", "Real", "Recto", "Reyes", "Rizal", "Rivera",
        "Robles", "Roces", "Rodriguez", "Rojas", "Rolon", "Rosales", "Roxas",

        // S
        "Salazar", "Salonga", "Samson", "Santos", "Sarmiento", "Sebastian",
        "Soriano", "Suarez", "Sumulong",

        // T
        "Tabora", "Tadena", "Talavera", "Tamayo", "Tan", "Tañada",
        "Tejada", "Tiongson", "Tolentino", "Torres", "Trinidad", "Tuazon",

        // U
        "Ubaldo", "Urbano", "Urquico",

        // V
        "Valdez", "Valencia", "Valenzuela", "Velasco", "Velasquez",
        "Vergara", "Villanueva", "Villareal", "Villegas",

        // Y
        "Yambao", "Yap", "Yatco", "Yumul",

        // Z
        "Zabala", "Zamora", "Zaragoza", "Zarate", "Zavalla", "Zialcita"
        ];
        const middleNames = ["Lee", "Ann", "Marie", "Cruz", "Santos", "Reyes"];
        const civilStatusOptions = ["Single", "Married", "Widowed", "Separated"];
        const pwdTypeOptions = ["Physical", "Visual", "Hearing", "Intellectual", "Mental", "Speech"];
        const workOptions = [
        "Accountant", "Actor", "Actress", "Agriculturist", "Airline Crew",
        "Architect", "Artist", "Baker", "Bank Teller", "Barangay Official",
        "Barber", "Bartender", "Call Center Agent", "Carpenter", "Cashier",
        "Chef", "Civil Engineer", "Clerk", "Construction Worker", "Counselor",
        "Customer Service Representative", "Dentist", "Doctor", "Driver", "Electrician",
        "Entrepreneur", "Factory Worker", "Farmer", "Fisherman", "Forester",
        "Graphic Designer", "Government Employee", "Housekeeper", "IT Specialist", "Janitor",
        "Jeepney Driver", "Journalist", "Judge", "Laborer", "Lawyer",
        "Librarian", "Machinist", "Manager", "Mason", "Mechanic",
        "Medical Technologist", "Midwife", "Military Personnel", "Nurse", "OFW",
        "Painter", "Pharmacist", "Photographer", "Pilot", "Plumber",
        "Police Officer", "Professor", "Sales Agent", "Security Guard", "Seafarer",
        "Service Crew", "Singer", "Social Worker", "Soldier", "Storekeeper",
        "Street Vendor", "Tailor", "Teacher", "Tour Guide", "Tricycle Driver",
        "Vendor", "Veterinarian", "Waiter", "Welder"
        ];
        const positionOptions = ["Resident"]; // Always Resident for generated families
        const monthlyIncomeOptions = [
        1000, 2000, 3000, 4000, 5000,
        6000, 7000, 8000, 9000, 10000,
        12000, 15000, 18000, 20000, 25000,
        30000, 35000, 40000, 45000, 50000,
        60000, 70000, 80000, 90000, 100000,
        120000, 150000, 200000, 250000, 300000,
        400000, 500000
        ];


        for (const household of households) {
            const householdId = household._id;

            // Determine gender, prioritizing female if pregnant women quota not met
            let gender = getRandomItem(["Male", "Female"]);
            if (pregnantWomenCount < minimumPregnantWomen && Math.random() < 0.6) { // 60% chance to be female if quota not met
                gender = "Female";
            }

            // Generate birthdate for >= 18 years old
            const currentYear = new Date().getFullYear();
            const minAge = 18;
            const maxAge = 65; // Max reasonable age for a new family head
            const bYear = currentYear - getRandomNumber(minAge, maxAge);
            const bMonth = getRandomNumber(1, 12);
            const bDay = getRandomNumber(1, 28); // Simpler, avoids month-day complexities
            const birthPlace = getRandomItem(birthPlaces);

            const firstName = gender === "Male" ? getRandomItem(firstNamesMale) : getRandomItem(firstNamesFemale);
            const lastName = getRandomItem(lastNames);
            const middleName = getRandomItem(middleNames);
            const extName = Math.random() < 0.1 ? getRandomItem(["Jr.", "Sr.", "III"]) : ""; // 10% chance for extName

            // Generate other resident details
            const civilStatus = getRandomItem(civilStatusOptions);
            const phone = `09${getRandomNumber(100000000, 999999999)}`;
            const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}@gmail.com`;

            // Solo Parent and PWD randomization
            const soloParent = Math.random() < 0.2 ? "on" : "no"; // 20% chance to be a solo parent
            const pwd = Math.random() < 0.15 ? "on" : "no"; // 15% chance to be PWD
            const precinct = Math.random() < 0.8 ? "Registered Voter" : "Non-Voter";
            const pwdType = pwd === "on" ? getRandomItem(pwdTypeOptions) : "";

            function getWeightedRandomItem(items) {
            const totalWeight = items.reduce((sum, item) => sum + item.weight, 0);
            const random = Math.random() * totalWeight;

            let currentWeight = 0;
            for (const item of items) {
                currentWeight += item.weight;
                if (random < currentWeight) {
                    return item.value;
                }
            }
        }

        // Define the employment statuses with their weights (probabilities)
        const employmentStatusWeightedOptions = [
            { value: "Employed", weight: 25 }, // 15% probability
            { value: "Unemployed", weight: 40 }, // 60% probability
            { value: "Self-Employed", weight: 35 / 5 }, // Remaining 25% divided among the rest
            { value: "Retired", weight: 35 / 5 },
            { value: "Student", weight: 35 / 5 },
            { value: "Dependent", weight: 35 / 5 },
            { value: "Pensioner", weight: 35 / 5 }
        ];
        
            const photoFilename = gender === "Female" ? getRandomItem(femalePhotos) : getRandomItem(malePhotos);
            const photo = `/uploads/${photoFilename}`;

        // Use the new function to get the random status
            const employmentStatus = getWeightedRandomItem(employmentStatusWeightedOptions);
            const work = employmentStatus === "Employed" || employmentStatus === "Self-Employed" ? getRandomItem(workOptions) : "";
            const monthlyIncome = ["Unemployed", "Retired", "Student", "Dependent"].includes(employmentStatus) ? 0 : getRandomItem(monthlyIncomeOptions);
            const position = getRandomItem(positionOptions); // Always "Resident"

            const income = parseFloat(monthlyIncome);
            let poverty = "Non-Indigent"; // Default
            if (income < 7500) {
                poverty = "Indigent";
            } else if (income >= 7500 && income <= 10000) {
                poverty = "Low Income";
            }

            // Determine pregnant status
            let pregnant = "No";
            if (gender === "Female" && pregnantWomenCount < minimumPregnantWomen && Math.random() < 0.4) { // 40% chance for female to be pregnant if quota not met
                pregnant = "on";
                pregnantWomenCount++;
            }

            const username = generateUsername(firstName, middleName, lastName, bDay, bYear);
            const password = generateRandomPassword();
            const rel = gender === "Male" ? "Father" : "Mother";

            // Create new family document first
            const newFamily = {
                familyIncome: income,
                poverty,
                archive: 0,
                updatedAt: new Date(),
                createdAt: new Date(),
                householdId: householdId,
                dump: "1", // Set dump to "1" for family
            };

            const familyResult = await familiesCollection.insertOne(newFamily);
            const familyId = familyResult.insertedId;

            // Create new resident document
            const newResident = {
                firstName, middleName, lastName, extName, birthPlace,
                bMonth, bDay, bYear, gender, civilStatus, pregnant, precinct, phone, email,
                soloParent, pwd, pwdType, employmentStatus, work, monthlyIncome: income, position, photo,
                archive: 0,
                reset: 0,
                createdAt: new Date(),
                updatedAt: new Date(),
                successAt: null,
                username,
                password,
                role: "Head", // Family head
                familyId,
                householdId,
                access: 0, // Access 0 for "Resident"
                rel,
                dump: "1", // Set dump to "1" for resident
            };

            residentsToInsert.push(newResident);
        }

        // After initial generation, check if we met the minimum pregnant women count
        let remainingPregnantNeeded = minimumPregnantWomen - pregnantWomenCount;
        if (remainingPregnantNeeded > 0) {
            // Find existing non-pregnant female residents from the generated batch and update them
            for (let i = 0; i < residentsToInsert.length && remainingPregnantNeeded > 0; i++) {
                if (residentsToInsert[i].gender === "Female" && residentsToInsert[i].pregnant === "No") {
                    residentsToInsert[i].pregnant = "Yes";
                    remainingPregnantNeeded--;
                }
            }
        }
        
        // Insert all generated residents in bulk
        await residentsCollection.insertMany(residentsToInsert);

        res.status(200).json({ success: true, message: `Successfully generated families and residents for ${households.length} households.` });

    } catch (error) {
        console.error("Error generating families and residents:", error);
        res.status(500).json({ success: false, message: "Error generating families and residents." });
    }
});

app.post("/generate-admin", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, message: "Database not connected" });
        }

        const residentsCollection = db.collection("resident");
        const familiesCollection = db.collection("family");

        // --- Create 1 Family (Admin Family) ---
        const newFamily = {
            familyIncome: 0,
            poverty: "Non-Indigent",
            archive: 0,
            updatedAt: new Date(),
            createdAt: new Date(),
            householdId: null, // not tied to a household
            dump: "1"
        };

        const familyResult = await familiesCollection.insertOne(newFamily);
        const familyId = familyResult.insertedId;

        // --- Base Resident data ---
        const baseResident = {
            middleName: "Sample",
            extName: "",
            birthPlace: "Muñoz",
            bMonth: 1,
            bDay: 1,
            bYear: 1990,
            civilStatus: "Single",
            phone: "09123456789",
            email: "",
            soloParent: "no",
            pwd: "no",
            pwdType: "",
            precinct: "Registered Voter",
            monthlyIncome: 0,
            archive: 0,
            reset: 0,
            createdAt: new Date(),
            updatedAt: new Date(),
            successAt: null,
            password: "all456", // default password
            familyId,
            householdId: null,
            access: 1, // maybe higher access for admins
            dump: "1"
        };

        const punongBarangay = {
            ...baseResident,
            firstName: "Juan",
            lastName: "Dela Cruz",
            gender: "Male",
            position: "Punong Barangay",
            username: "Punong Barangay",
            role: "Admin",
            rel: "N/A"
        };

        const secretary = {
            ...baseResident,
            firstName: "Maria",
            lastName: "Reyes",
            gender: "Female",
            position: "Secretary",
            username: "Secretary",
            role: "Admin",
            rel: "N/A"
        };

        // Insert both only once
        await residentsCollection.insertMany([punongBarangay, secretary]);

        res.status(200).json({ success: true, message: "Successfully generated Punong Barangay and Secretary." });

    } catch (error) {
        console.error("Error generating admin residents:", error);
        res.status(500).json({ success: false, message: "Error generating admin residents." });
    }
});


app.post("/delete-archived-families", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, message: "Database not connected" });
        }

        const familyCollection = db.collection("family");
        const residentCollection = db.collection("resident");

        // Delete from family collection
        const familyResult = await familyCollection.deleteMany({
            $or: [
                { dump: "1" },
                { dump: 1 }
            ]
        });

        // Delete from resident collection
        const residentResult = await residentCollection.deleteMany({
            $or: [
                { dump: "1" },
                { dump: 1 }
            ]
        });

        const totalDeleted = familyResult.deletedCount + residentResult.deletedCount;

        if (totalDeleted > 0) {
            res.status(200).json({
                success: true,
                message: `Successfully deleted ${totalDeleted} archived documents (${familyResult.deletedCount} families, ${residentResult.deletedCount} residents).`
            });
        } else {
            res.status(200).json({
                success: false,
                message: "No archived households or residents found to delete."
            });
        }
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ success: false, message: "Error deleting archived households and residents" });
    }
});

app.post("/delete-archived-residents", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, message: "Database not connected" });
        }

        const householdCollection = db.collection("resident");

        // Delete all documents where 'archive' field is "3" or 3
        const result = await householdCollection.deleteMany({
            $or: [
                { dump: "2" },
                { dump: 2 }
            ]
        });

        if (result.deletedCount > 0) {
            res.status(200).json({ success: true, message: `Successfully deleted ${result.deletedCount} archived households.` });
        } else {
            res.status(200).json({ success: false, message: "No households with archive status '3' found to delete." });
        }
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ success: false, message: "Error deleting archived households" });
    }
});

//All about documents
app.get("/ovr", isLogin, async (req, res) => {
    // Get query params for filtering
    const { start, end, filter, specificDate } = req.query;

    let matchFilter = { archive: { $in: [0, "0"] } }; // default filter
    const now = new Date();

    if (filter === "today") {
        const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const endOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        matchFilter.createdAt = { $gte: startOfDay, $lt: endOfDay };
    } else if (filter === "thisMonth") {
        const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        matchFilter.createdAt = { $gte: startOfMonth, $lt: startOfNextMonth };
    } else if (filter === "lastMonth") {
        const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
        const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
        matchFilter.createdAt = { $gte: startOfLastMonth, $lt: startOfThisMonth };
    } else if (filter === "thisYear") {
        const startOfYear = new Date(now.getFullYear(), 0, 1);
        const startOfNextYear = new Date(now.getFullYear() + 1, 0, 1);
        matchFilter.createdAt = { $gte: startOfYear, $lt: startOfNextYear };
    } else if (filter === "lastYear") {
        const startOfLastYear = new Date(now.getFullYear() - 1, 0, 1);
        const startOfThisYear = new Date(now.getFullYear(), 0, 1);
        matchFilter.createdAt = { $gte: startOfLastYear, $lt: startOfThisYear };
    } else if (req.query.specificDate) {
        const date = new Date(req.query.specificDate);
        const nextDay = new Date(date);
        nextDay.setDate(date.getDate() + 1);
        matchFilter.createdAt = { $gte: date, $lt: nextDay };
    } else if (start && end) {
        matchFilter.createdAt = { $gte: new Date(start), $lte: new Date(end) };
    }

let trendGroupStage;

if (filter === "today" || specificDate) {
    // group by hour
    trendGroupStage = {
        $group: {
            _id: { $dateTrunc: { date: "$createdAt", unit: "hour", timezone: "Asia/Manila" } },
            count: { $sum: 1 }
        }
    };
} else if (filter === "thisMonth" || filter === "lastMonth") {
    // group by day
    trendGroupStage = {
        $group: {
            _id: { $dateTrunc: { date: "$createdAt", unit: "day", timezone: "Asia/Manila" } },
            count: { $sum: 1 }
        }
    };
} else if (filter === "thisYear" || filter === "lastYear") {
    // group by month
    trendGroupStage = {
        $group: {
            _id: { $dateTrunc: { date: "$createdAt", unit: "month", timezone: "Asia/Manila" } },
            count: { $sum: 1 }
        }
    };
} else if (start && end) {
    // If custom range < 31 days → group by day, else by month
    const diffDays = (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24);
    trendGroupStage = {
        $group: {
            _id: { $dateTrunc: { date: "$createdAt", unit: diffDays <= 31 ? "day" : "month", timezone: "Asia/Manila" } },
            count: { $sum: 1 }
        }
    };
} else {
    // Default → group by week
    trendGroupStage = {
        $group: {
            _id: { $dateTrunc: { date: "$createdAt", unit: "week", timezone: "Asia/Manila" } },
            count: { $sum: 1 }
        }
    };
}

    try {
        if (!req.session.userId) return res.redirect("/");

        // Timezone for date bucketing (your local time)
        const tz = "Asia/Manila";

        const cursor = db.collection("request").aggregate([
            { $match: matchFilter },
            {
                $lookup: {
                    from: "resident",
                    let: { rId: "$requestBy" },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $or: [
                                        { $eq: ["$_id", "$$rId"] },
                                        { $eq: ["$_id", { $toObjectId: "$$rId" }] }
                                    ]
                                }
                            }
                        }
                    ],
                    as: "resident"
                }
            },
            { $unwind: { path: "$resident", preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: "household",
                    let: { hhId: "$resident.householdId" },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $eq: ["$_id", {
                                        $cond: [
                                            { $eq: [{ $type: "$$hhId" }, "objectId"] }, "$$hhId",
                                            { $toObjectId: "$$hhId" }
                                        ]
                                    }]
                                }
                            }
                        }
                    ],
                    as: "household"
                }
            },
            { $unwind: { path: "$household", preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: "family",
                    let: { famId: "$resident.familyId" },
                    pipeline: [
                        {
                            $match: {
                                $expr: {
                                    $eq: ["$_id", {
                                        $cond: [
                                            { $eq: [{ $type: "$$famId" }, "objectId"] }, "$$famId",
                                            { $toObjectId: "$$famId" }
                                        ]
                                    }]
                                }
                            }
                        }
                    ],
                    as: "family"
                }
            },
            { $unwind: { path: "$family", preserveNullAndEmptyArrays: true } },
            {
                $lookup: {
                    from: "document",
                    localField: "_id",
                    foreignField: "reqId",
                    as: "documents"
                }
            },
            {
                $addFields: {
                    durationHours: {
                        $cond: [
                            { $and: ["$createdAt", "$turnAt"] },
                            { $divide: [{ $subtract: ["$turnAt", "$createdAt"] }, 1000 * 60 * 60] },
                            null
                        ]
                    },
                    day: { $dateTrunc: { date: "$createdAt", unit: "day", timezone: tz } },
                    week: { $dateTrunc: { date: "$createdAt", unit: "week", timezone: tz } },
                    month: { $dateTrunc: { date: "$createdAt", unit: "month", timezone: tz } },
                    hourOfDay: { $hour: { date: "$createdAt", timezone: tz } },
                    dayOfWeek: { $isoDayOfWeek: { date: "$createdAt", timezone: tz } },
                }
            },
            {
                $addFields: {
                    dob: {
                        $let: {
                            vars: {
                                year: { $toInt: { $ifNull: ["$resident.bYear", 0] } },
                                month: { $toInt: { $ifNull: ["$resident.bMonth", 1] } },
                                day: { $toInt: { $ifNull: ["$resident.bDay", 1] } }
                            },
                            in: {
                                $cond: [
                                    { $gte: ["$$year", 1900] },
                                    { $dateFromParts: { year: "$$year", month: "$$month", day: "$$day" } },
                                    null
                                ]
                            }
                        }
                    }
                }
            },
            {
                $addFields: {
                    age: {
                        $cond: [
                            { $ne: ["$dob", null] },
                            { $floor: { $divide: [{ $subtract: ["$$NOW", "$dob"] }, 1000 * 60 * 60 * 24 * 365.25] } },
                            null
                        ]
                    },
                    ageGroup: {
                        $switch: {
                            branches: [
                                { case: { $and: [{ $ne: ["$age", null] }, { $lt: ["$age", 18] }] }, then: "Minor" },
                                { case: { $and: [{ $ne: ["$age", null] }, { $gte: ["$age", 18] }, { $lt: ["$age", 25] }] }, then: "Youth" },
                                { case: { $and: [{ $ne: ["$age", null] }, { $gte: ["$age", 25] }, { $lt: ["$age", 30] }] }, then: "Mid-Age" },
                                { case: { $and: [{ $ne: ["$age", null] }, { $gte: ["$age", 30] }, { $lt: ["$age", 60] }] }, then: "Adult" }
                            ],
                            default: { $cond: [{ $eq: ["$age", null] }, "Unknown", "Senior"] }
                        }
                    },
                    voterType: {
                        $switch: {
                            branches: [
                                { case: { $and: [{ $ne: ["$age", null] }, { $gte: ["$age", 16] }, { $lte: ["$age", 29] }] }, then: "SK" }
                            ],
                            default: { $cond: [{ $eq: ["$age", null] }, "Unknown", "Regular"] }
                        }
                    },
                    povertyNorm: {
                        $switch: {
                            branches: [
                                {
                                    case: {
                                        $in: [
                                            { $toLower: { $ifNull: ["$family.poverty", ""] } },
                                            ["yes", "indigent", "true"]
                                        ]
                                    },
                                    then: "Indigent"
                                },
                                {
                                    case: {
                                        $in: [
                                            { $toLower: { $ifNull: ["$family.poverty", ""] } },
                                            ["no", "non-indigent", "false"]
                                        ]
                                    },
                                    then: "Non-Indigent"
                                }
                            ],
                            default: "Unknown"
                        }
                    }
                }
            },
            {$addFields: {
                durationHours: {
                    $cond: [
                        { $and: ["$createdAt", "$turnAt"] },
                        { $divide: [{ $subtract: ["$turnAt", "$createdAt"] }, 1000 * 60 * 60] },
                        null
                    ]
                },
                day: { $dateTrunc: { date: "$createdAt", unit: "day", timezone: tz } },
                week: { $dateTrunc: { date: "$createdAt", unit: "week", timezone: tz } },
                month: { $dateTrunc: { date: "$createdAt", unit: "month", timezone: tz } },
                hourOfDay: { $hour: { date: "$createdAt", timezone: tz } },
                dayOfWeek: { $isoDayOfWeek: { date: "$createdAt", timezone: tz } },

                // New field: time from approval to claimed
                approvalToClaimHours: {
                    $cond: [
                        { $and: ["$turnAt", "$successAt"] }, // Only calculate if both exist
                        { $divide: [{ $subtract: ["$successAt", "$turnAt"] }, 1000 * 60 * 60] },
                        null
                    ]
                }
            }
            },
            {
                $addFields: {
                    debugDOB: {
                        bYearType: { $type: "$resident.bYear" },
                        bMonthType: { $type: "$resident.bMonth" },
                        bDayType: { $type: "$resident.bDay" },
                        bYearValue: "$resident.bYear",
                        bMonthValue: "$resident.bMonth",
                        bDayValue: "$resident.bDay"
                    }
                }
            },
            {
                $facet: {
                    statusCounts: [{ $group: { _id: "$status", count: { $sum: 1 } } }],

                    trend: [ trendGroupStage, { $sort: { _id: 1 } } ],

                    avgProcessingTime: [{ $match: { durationHours: { $ne: null } } }, { $group: { _id: null, avgHours: { $avg: "$durationHours" } } }],

                    turnaroundPerStatus: [{ $match: { durationHours: { $ne: null } } }, { $group: { _id: "$status", avgHours: { $avg: "$durationHours" } } }],

                    peakHours: [{ $group: { _id: "$hourOfDay", count: { $sum: 1 } } }, { $sort: { _id: 1 } }],

                    peakDaysOfWeek: [{ $group: { _id: "$dayOfWeek", count: { $sum: 1 } } }, { $sort: { _id: 1 } }],

                    requestStatusCounts: [{ $group: { _id: "$status", count: { $sum: 1 } } }],

                    requestApprovalTime: [{ $match: { reqApprovalHours: { $ne: null } } }, { $group: { _id: null, avgHours: { $avg: "$reqApprovalHours" } } }],

                    requestApprovalTimeByStatus: [{ $match: { reqApprovalHours: { $ne: null } } }, { $group: { _id: "$status", avgHours: { $avg: "$reqApprovalHours" } } }, { $sort: { avgHours: 1 } }],

                    docTypes: [{ $unwind: "$documents" }, { $group: { _id: "$documents.type", reqCount: { $sum: 1 }, totalQty: { $sum: { $ifNull: ["$documents.qty", 1] } } } }, { $addFields: { avgQty: { $cond: [{ $gt: ["$reqCount", 0] }, { $divide: ["$totalQty", "$reqCount"] }, 0] } } }, { $sort: { totalQty: -1 } }],

                    purposes: [{ $unwind: "$documents" }, { $group: { _id: { $ifNull: ["$documents.purpose", "Unknown"] }, count: { $sum: 1 } } }, { $sort: { count: -1 } }],

                    approvalDecline: [{ $unwind: "$documents" }, { $group: { _id: { $ifNull: ["$documents.status", "Unknown"] }, count: { $sum: 1 } } }],

                    approvalToClaimTime: [
                        { $match: { turnAt: { $ne: null }, successAt: { $ne: null } } }, // Only consider docs with both times
                        {
                            $addFields: {
                                approvalToClaimHours: {
                                    $divide: [{ $subtract: ["$successAt", "$turnAt"] }, 1000 * 60 * 60] // ms to hours
                                }
                            }
                        },
                        {
                            $group: {
                                _id: null,
                                avgHours: { $avg: "$approvalToClaimHours" } // Average waiting time
                            }
                        }
                    ],

                    approvalTimeByDocType: [{ $unwind: "$documents" }, { $match: { "documents.status": "Approved" } }, { $addFields: { docDecisionHours: { $divide: [{ $subtract: ["$documents.updatedAt", "$createdAt"] }, 1000 * 60 * 60] } } }, { $match: { docDecisionHours: { $ne: null } } }, { $group: { _id: "$documents.type", avgHours: { $avg: "$docDecisionHours" }, count: { $sum: 1 } } }, { $sort: { avgHours: 1 } }],

                    declineReasons: [{ $unwind: "$documents" }, { $match: { "documents.status": "Declined" } }, { $group: { _id: { $trim: { input: { $ifNull: ["$documents.remarks", "$remarkMain"] } } }, count: { $sum: 1 } } }, { $sort: { count: -1 } }],

                    byGender: [{ $group: { _id: { $ifNull: ["$resident.gender", "Unknown"] }, count: { $sum: 1 } } }],

                    byCivilStatus: [{ $group: { _id: { $ifNull: ["$resident.civilStatus", "Unknown"] }, count: { $sum: 1 } } }],

                    byAgeGroup: [{ $group: { _id: "$ageGroup", count: { $sum: 1 } } }, { $sort: { _id: 1 } }],

                    byVoterType: [{ $group: { _id: "$voterType", count: { $sum: 1 } } }],

                    byPurok: [{ $group: { _id: { $ifNull: ["$household.purok", "Unknown"] }, count: { $sum: 1 } } }, { $sort: { count: -1 } }],
                    topHouseholds: [{ $group: { _id: "$household._id", houseNo: { $first: "$household.houseNo" }, purok: { $first: "$household.purok" }, count: { $sum: 1 } } }, { $sort: { count: -1 } }, { $limit: 5 }],

                    povertyCounts: [{ $group: { _id: "$povertyNorm", count: { $sum: 1 } } }],

                    byMonthlyIncome: [{ $group: { _id: { $ifNull: ["$resident.monthlyIncome", "Unknown"] }, count: { $sum: 1 } } }, { $sort: { _id: 1 } }],

                    requestsPerResident: [
                    { 
                        $group: { 
                        _id: "$resident._id",
                        fullName: { 
                            $first: { 
                            $concat: [
                                "$resident.firstName", 
                                " ", 
                                { $ifNull: ["$resident.lastName", ""] }
                            ] 
                            } 
                        },
                        photo: { $first: "$resident.photo" }, // ✅ include photo
                        count: { $sum: 1 } 
                        } 
                    },
                    { $sort: { count: -1 } },
                    { $limit: 5 }
                    ],

                    repeatShortInterval: [
                    { 
                        $setWindowFields: { 
                        partitionBy: "$resident._id", 
                        sortBy: { createdAt: 1 }, 
                        output: { 
                            prevCreatedAt: { 
                            $shift: { output: "$createdAt", by: -1 } 
                            } 
                        } 
                        } 
                    },
                    { 
                        $addFields: { 
                        diffDays: { 
                            $divide: [
                            { $subtract: ["$createdAt", "$prevCreatedAt"] }, 
                            1000 * 60 * 60 * 24
                            ] 
                        } 
                        } 
                    },
                    { $match: { diffDays: { $ne: null, $lte: 7 } } },
                    { 
                        $group: { 
                        _id: "$resident._id", 
                        fullName: { 
                            $first: { 
                            $concat: [
                                "$resident.firstName", 
                                " ", 
                                { $ifNull: ["$resident.lastName", ""] }
                            ] 
                            } 
                        },
                        photo: { $first: "$resident.photo" }, // ✅ added photo
                        repeats: { $sum: 1 } 
                        } 
                    },
                    { $sort: { repeats: -1 } },
                    { $limit: 5 }
                    ]
                }
            }
        ], { allowDiskUse: true });

        const [data] = await cursor.toArray();

        // Call the separate function to get the age distribution
        // This is the key line to fix your error
        const ageDistribution = await getAgeDistributionFromRequests(matchFilter);

        // Normalize fixed status list with zeros
        const fixedStatuses = ["Processing", "Pending", "For Pickup", "Claimed", "Declined", "Cancelled"];
        const statusCounts = Object.fromEntries(fixedStatuses.map(s => [s, 0]));
        for (const s of (data.statusCounts || [])) {
            if (s._id && statusCounts.hasOwnProperty(s._id)) statusCounts[s._id] = s.count;
        }

        const totalCount = fixedStatuses.reduce((a, s) => a + (statusCounts[s] || 0), 0);
        const statusPercentages = Object.fromEntries(
            fixedStatuses.map(s => [s, totalCount ? ((statusCounts[s] / totalCount) * 100).toFixed(2) : "0.00"])
        );

        const fixedReqStatuses = ["Processing", "Pending", "For Pickup", "Claimed", "Declined"];
        const requestStatusCountsMap = Object.fromEntries(fixedReqStatuses.map(s => [s, 0]));
        for (const s of (data.requestStatusCounts || [])) {
            if (s._id && requestStatusCountsMap.hasOwnProperty(s._id)) {
                requestStatusCountsMap[s._id] = s.count;
            }
        }
        const requestStatusLabels = fixedReqStatuses;
        const requestStatusValues = Object.values(requestStatusCountsMap);

        const avgTurnaroundHours =
            (data.avgProcessingTime && data.avgProcessingTime[0] && data.avgProcessingTime[0].avgHours) ? Number(data.avgProcessingTime[0].avgHours.toFixed(2)) : 0;

            // Average time from approval (turnAt) to claimed (successAt)
        const avgApprovalToClaimHours = data.approvalToClaimTime?.[0]?.avgHours
            ? Number(data.approvalToClaimTime[0].avgHours.toFixed(2))
            : 0;

            let trendUnit = "week"; // default
            if (filter === "today" || specificDate) trendUnit = "hour";
            else if (filter === "thisMonth" || filter === "lastMonth") trendUnit = "day";
            else if (filter === "thisYear" || filter === "lastYear") trendUnit = "month";
            else if (start && end) {
                const diffDays = (new Date(end) - new Date(start)) / (1000 * 60 * 60 * 24);
                trendUnit = diffDays <= 31 ? "day" : "month";
            }


        // Render with all data
        res.render("ovr", {
            layout: "layout",
            title: "Overview",
            activePage: "ovr",
            data,
            currentFilter: req.query.filter || "all",
            specificDate: specificDate || "",
            start: start || "",
            end: end || "",
            ageDistribution, // Now this variable exists and contains your data

            // Overview
            totalCount,
            statusCounts,
            statusPercentages,
            avgTurnaroundHours,
            avgApprovalToClaimHours,
            requestStatusLabels,
            requestStatusValues,
            turnaroundPerStatus: data.turnaroundPerStatus || [],
            trend: data.trend || [],
            trendUnit,  // ✅ add this here
            peakHours: data.peakHours || [],
            peakDaysOfWeek: data.peakDaysOfWeek || [],
            
            // Documents
            docTypes: data.docTypes || [],
            purposes: data.purposes || [],
            approvalDecline: data.approvalDecline || [],
            approvalTimeByDocType: data.approvalTimeByDocType || [],
            declineReasons: data.declineReasons || [],

            // Demographics
            byGender: data.byGender || [],
            byCivilStatus: data.byCivilStatus || [],
            byAgeGroup: data.byAgeGroup || [],
            byVoterType: data.byVoterType || [],

            // Geo/household
            byPurok: data.byPurok || [],
            topHouseholds: data.topHouseholds || [],

            // Socio-economic
            povertyCounts: data.povertyCounts || [],
            byMonthlyIncome: data.byMonthlyIncome || [],

            // User behavior
            requestsPerResident: data.requestsPerResident || [],
            repeatShortInterval: data.repeatShortInterval || [],
            requestStatusCounts: data.requestStatusCounts || [],
            requestApprovalTime: (data.requestApprovalTime && data.requestApprovalTime[0] && data.requestApprovalTime[0].avgHours) ? Number(data.requestApprovalTime[0].avgHours.toFixed(2)) : 0,
            requestApprovalTimeByStatus: data.requestApprovalTimeByStatus || [],
        });

    } catch (err) {
        console.error("❌ Error in /ovr route:", err);
        res.status(500).send('<script>alert("Internal Server Error!"); window.location="/";</script>');
    }
});

// The getAgeDistributionFromRequests function remains the same as provided
// Make sure it is defined outside the route handler, and inside a file you can require.
// For example, in a file named `analytics.js`
// const moment = require('moment'); // Make sure moment is installed and imported if you're using a separate file

async function getAgeDistributionFromRequests(matchFilter  = {}) {
    try {
        const requests = await db.collection("request").aggregate([
            { $match: matchFilter },
            {
                $lookup: {
                    from: "resident",
                    localField: "requestBy",
                    foreignField: "_id",
                    as: "resident"
                }
            },
            { $unwind: "$resident" },
            {
                $project: {
                    _id: 0,
                    bMonth: "$resident.bMonth",
                    bDay: "$resident.bDay",
                    bYear: "$resident.bYear"
                }
            }
        ]).toArray();

        const ageGroups = {
            "0-5": 0, "6-11": 0, "1-5": 0, "6-12": 0, "13-17": 0,
            "18-29": 0, "30-59": 0, "Senior": 0, "Youth": 0,
        };
        
        function calculateAge(bMonth, bDay, bYear) {
            if (!bMonth || !bDay || !bYear) return 0;
            const birthDate = moment(`${bYear}-${bMonth}-${bDay}`);
            return moment().diff(birthDate, 'years');
        }

        requests.forEach(req => {
            const age = calculateAge(req.bMonth, req.bDay, req.bYear);

            if (age >= 0 && age <= 5) { ageGroups["0-5"]++; }
            if (age >= 6 && age <= 11) { ageGroups["6-11"]++; }
            if (age >= 1 && age <= 5) { ageGroups["1-5"]++; }
            if (age >= 6 && age <= 12) { ageGroups["6-12"]++; }
            if (age >= 13 && age <= 17) { ageGroups["13-17"]++; }
            if (age >= 18 && age <= 29) { ageGroups["18-29"]++; }
            if (age >= 30 && age <= 59) { ageGroups["30-59"]++; }
            if (age >= 60) { ageGroups["Senior"]++; }
            // The `req.precinct` check here is missing since it was not part of the project stage.
            // If you need it, add `precinct: "$resident.precinct"` to the project stage.
            if (age >= 15 && age <= 30) { ageGroups["Youth"]++; } 
        });

        return ageGroups;

    } catch (error) {
        console.error("Error generating age distribution:", error);
        return {};
    }
}


app.get("/ind", isLogin, async (req, res) => {
    try {
        const residents = await db.collection("resident")
            .find({ archive: { $in: [0, "0"] } })
            .sort({ firstName: 1 })
            .toArray();

        const households = await db.collection("household")
            .find({ archive: { $in: [0, "0"] } })
            .toArray();

        const families = await db.collection("family")
            .find({ archive: { $in: [0, "0"] } })
            .toArray();

        // Map household and family data
        const householdMap = new Map();
        households.forEach(household => {
            householdMap.set(String(household._id), { houseNo: household.houseNo, purok: household.purok });
        });

        const familyMap = new Map();
        families.forEach(family => {
            familyMap.set(String(family._id), { poverty: family.poverty });
        });

        // Process residents
        residents.forEach(resident => {
            // Get household details
            const householdData = householdMap.get(String(resident.householdId)) || { houseNo: "-", purok: "-" };
            resident.houseNo = householdData.houseNo;
            resident.purok = householdData.purok;

            // Get family details
            const familyData = familyMap.get(String(resident.familyId)) || { poverty: "No Income" };
            resident.familyPoverty = familyData.poverty;
        }); 
 
        // ✅ Only keep indigent residents
        const indigentResidents = residents.filter(r => r.familyPoverty === "Indigent");

        // Get total counts from actual collections
        const totalHouseholds = households.length;
        const totalFamilies = families.filter(f => f.poverty === "Indigent").length;
        const totalInhabitants = indigentResidents.length;
        const totalVoters = residents.filter(resident => resident.precinct === "Registered Voter").length;

        residents.forEach(resident => {
        // Get household details
        const householdData = householdMap.get(String(resident.householdId)) || { houseNo: "-", purok: "-" };
        resident.houseNo = householdData.houseNo;
        resident.purok = householdData.purok;

        // Get family details
        const familyData = familyMap.get(String(resident.familyId)) || { poverty: "No Income" };
        resident.familyPoverty = familyData.poverty;
        });


        res.render("ind", {
            layout: "layout",
            title: "Residents",
            activePage: "ind",
            residents: indigentResidents,
            totalHouseholds,
            totalFamilies,
            totalInhabitants,
            totalVoters,
            titlePage : "Indigent Residents",
            moment
        });
    } catch (err) {
        console.error("❌ Error fetching residents:", err);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});


app.get("/indF", isLogin, async (req, res) => {

    try {
        // Fetch only non-archived families, households, and residents
        const [families, households, residents] = await Promise.all([
            db.collection("family").find({ archive: { $in: [0, "0"] } }).toArray(),
            db.collection("household").find({ archive: { $in: [0, "0"] } }).toArray(),
            db.collection("resident").find({ archive: { $in: [0, "0"] } }).toArray()
        ]);

        // Create a map for quick household lookup
        const householdMap = Object.fromEntries(households.map(house => [
            house._id.toString(),
            { _id: house._id, houseNo: house.houseNo || "--", purok: house.purok }
        ]));

        // Initialize total counts
        let totalMembersCount = 0;
        let totalIndigent = 0;
        let totalLowIncome = 0;
        let totalNonIndigent = 0;

        // Process families
        const familyList = families.map(family => {
            const householdInfo = householdMap[family.householdId?.toString()] || { houseNo: "--", purok: "--"};

            // Get ALL residents of the family (both head and members)
            const familyMembersList = residents.filter(resident => 
                resident.familyId?.toString() === family._id.toString()
            );

            // Find the family head from the filtered list
            const familyHead = familyMembersList.find(resident => resident.role === "Head");

            // Handle missing names gracefully
            const familyHeadName = familyHead
                ? [familyHead.firstName, familyHead.middleName, familyHead.lastName, familyHead.extName].filter(Boolean).join(" ")
                : "--";

            // Prepare a list of all members with full names
            const membersData = familyMembersList.map(member => {
                return {
                    ...member,
                    fullName: [member.firstName, member.middleName, member.lastName, member.extName].filter(Boolean).join(" ")
                };
            });

            // The rest of the code remains the same
            const totalMembers = familyMembersList.length;
            totalMembersCount += totalMembers;
            const povertyStatus = family.poverty || "--";
            if (povertyStatus === "Indigent") totalIndigent++;
            if (povertyStatus === "Low Income") totalLowIncome++;
            if (povertyStatus === "Non-Indigent") totalNonIndigent++;

            return {
                _id: family._id,
                householdId: householdInfo._id,
                houseNo: householdInfo.houseNo,
                purok: householdInfo.purok,
                familyHead: familyHeadName,
                totalMembers,
                poverty: povertyStatus,
                members: membersData,
                familyIncome: family.familyIncome
            };
        });

        // Compute statistics
        const totalFamilies = families.length;
        const avgMembersPerFamily = totalFamilies > 0 ? (totalMembersCount / totalFamilies).toFixed(2) : 0;

        res.render("indF", {
            layout: "layout",
            title: "Families",
            activePage: "fml",
            families: familyList,
            totalFamilies,
            avgMembersPerFamily,
            totalIndigent,
            totalLowIncome,
            totalNonIndigent,
            titlePage: "Records of Families",
        });
    } catch (err) {
        console.error("Error fetching family data:", err.message);
        res.status(500).send('<script>alert("Internal Server Error! Please try again."); window.location="/";</script>');
    }
});

app.post("/delete-archived-residents2", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, message: "Database not connected" });
        }

        const householdCollection = db.collection("resident");

        // Delete all documents where 'archive' field is "3" or 3
        const result = await householdCollection.deleteMany({
            $or: [
                { position: "Punong Barangay" },
                { position: "Secretary" }
            ]
        });

        if (result.deletedCount > 0) {
            res.status(200).json({ success: true, message: `Successfully deleted ${result.deletedCount} archived households.` });
        } else {
            res.status(200).json({ success: false, message: "No households with archive status '3' found to delete." });
        }
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ success: false, message: "Error deleting archived households" });
    }
});

app.post("/delete-archived-families2", async (req, res) => {
    try {
        if (!db) {
            return res.status(500).json({ success: false, message: "Database not connected" });
        }

        const familyCollection = db.collection("family");
        const residentCollection = db.collection("resident");

        // Define start and end of the date (UTC)
        const startOfDay = new Date("2025-08-28T00:00:00.000Z");
        const endOfDay = new Date("2025-08-29T00:00:00.000Z"); // next day at midnight

        // Delete from family collection (anything on Aug 28, 2025)
        const familyResult = await familyCollection.deleteMany({
            createdAt: { $gte: startOfDay, $lt: endOfDay }
        });

        // Delete from resident collection (dump = 10 or "10")
        const residentResult = await residentCollection.deleteMany({
            dump: { $in: [10, "10"] }
        });

        const totalDeleted = familyResult.deletedCount + residentResult.deletedCount;

        if (totalDeleted > 0) {
            res.status(200).json({
                success: true,
                message: `Successfully deleted ${totalDeleted} archived documents (${familyResult.deletedCount} families, ${residentResult.deletedCount} residents).`
            });
        } else {
            res.status(200).json({
                success: false,
                message: "No archived households or residents found to delete."
            });
        }
    } catch (error) {
        console.error("Delete Error:", error);
        res.status(500).json({ success: false, message: "Error deleting archived households and residents" });
    }
});

// Start Server
app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
