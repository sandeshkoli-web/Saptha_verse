
require("dotenv").config();

const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const mysql = require("mysql2/promise");
const bcrypt = require("bcrypt");
const crypto = require("crypto");
const path = require("path");

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);

const PORT = Number(process.env.PORT || 3000);
const SECRET = process.env.JWT_SECRET;

const onlineStudents = new Map();

app.use(express.json());
app.use(express.static(__dirname));

const pool = mysql.createPool({
    host: process.env.DB_HOST || "localhost",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "saptha_connect",
    port: Number(process.env.DB_PORT || 3306),
    waitForConnections: true,
    connectionLimit: 10
});

if (!SECRET || !process.env.DB_PASSWORD) {
    console.error("Missing DB_PASSWORD or JWT_SECRET in .env");
    process.exit(1);
}

// CREATE LOGIN TOKEN
function createToken(user) {
    const payload = Buffer.from(
        JSON.stringify({
            id: Number(user.id),
            email: user.email,
            expires: Date.now() + 7 * 24 * 60 * 60 * 1000
        })
    ).toString("base64url");

    const signature = crypto
        .createHmac("sha256", SECRET)
        .update(payload)
        .digest("base64url");

    return `${payload}.${signature}`;
}

// VERIFY TOKEN
function verifyToken(token) {
    try {
        const parts = String(token || "").split(".");
        if (parts.length !== 2) return null;

        const [payload, signature] = parts;

        const expected = crypto
            .createHmac("sha256", SECRET)
            .update(payload)
            .digest();

        const received = Buffer.from(signature, "base64url");

        if (
            expected.length !== received.length ||
            !crypto.timingSafeEqual(expected, received)
        ) {
            return null;
        }

        const data = JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8")
        );

        if (
            !Number.isInteger(data.id) ||
            data.id <= 0 ||
            !Number.isFinite(data.expires) ||
            data.expires < Date.now()
        ) {
            return null;
        }

        return { id: data.id, email: data.email };
    } catch {
        return null;
    }
}

function requireLogin(req, res, next) {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ")
        ? header.slice(7)
        : "";

    const user = verifyToken(token);

    if (!user) {
        return res.status(401).json({
            success: false,
            message: "Please log in again."
        });
    }

    req.user = user;
    next();
}

// ONLINE STATUS HELPERS
function broadcastPresence(studentId, isOnline) {
    io.emit("presence:update", {
        studentId: Number(studentId),
        online: isOnline
    });
}

function getOnlineIds() {
    return Array.from(onlineStudents.keys()).map(Number);
}

// SOCKET.IO LOGIN AUTHENTICATION
io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const user = verifyToken(token);

    if (!user) {
        return next(new Error("Authentication required. Please log in."));
    }

    socket.user = user;
    next();
});

io.on("connection", (socket) => {
    const studentId = Number(socket.user.id);
    const wasOffline = !onlineStudents.has(studentId);

    if (wasOffline) {
        onlineStudents.set(studentId, new Set());
    }

    onlineStudents.get(studentId).add(socket.id);

    socket.emit("presence:initial", {
        onlineIds: getOnlineIds()
    });

    if (wasOffline) {
        broadcastPresence(studentId, true);
    }

    // Join a private conversation room after verifying the recipient.
    socket.on("chat:join", async (friendIdValue, callback) => {
        const friendId = Number(friendIdValue);

        if (
            !Number.isInteger(friendId) ||
            friendId <= 0 ||
            friendId === studentId
        ) {
            if (typeof callback === "function") {
                callback({ success: false, message: "Invalid student." });
            }
            return;
        }

        try {
            const [rows] = await pool.execute(
                "SELECT id FROM students WHERE id = ?",
                [friendId]
            );

            if (!rows.length) {
                if (typeof callback === "function") {
                    callback({ success: false, message: "Student not found." });
                }
                return;
            }

            const room = [studentId, friendId]
                .sort((a, b) => a - b)
                .join(":");

            await socket.join(`chat:${room}`);

            if (typeof callback === "function") {
                callback({ success: true });
            }
        } catch (error) {
            console.error("Chat room error:", error.message);

            if (typeof callback === "function") {
                callback({ success: false, message: "Could not open chat." });
            }
        }
    });

    // Deliver a newly saved message to both participants in real time.
    socket.on("disconnect", () => {
        const connections = onlineStudents.get(studentId);
        if (!connections) return;

        connections.delete(socket.id);

        if (connections.size === 0) {
            onlineStudents.delete(studentId);
            broadcastPresence(studentId, false);
        }
    });
});

// SERVER AND DATABASE CHECK
app.get("/api/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");

        res.json({
            success: true,
            message: "Server and database are working"
        });
    } catch (error) {
        console.error("Database health error:", error.message);

        res.status(500).json({
            success: false,
            message: "Database connection failed"
        });
    }
});

// REGISTER
app.post("/api/register", async (req, res) => {
    try {
        const {
            fullName,
            email,
            branch,
            semester,
            interests,
            password
        } = req.body;

        if (!fullName || !email || !branch || !semester || !password) {
            return res.status(400).json({
                success: false,
                message: "Please fill in all required fields."
            });
        }

        if (String(password).length < 8) {
            return res.status(400).json({
                success: false,
                message: "Password must contain at least 8 characters."
            });
        }

        const cleanEmail = String(email).trim().toLowerCase();
        const hashedPassword = await bcrypt.hash(String(password), 12);

        const [result] = await pool.execute(
            `INSERT INTO students
             (full_name, email, branch, semester, interests, password)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [
                String(fullName).trim(),
                cleanEmail,
                String(branch).trim(),
                String(semester).trim(),
                String(interests || "").trim(),
                hashedPassword
            ]
        );

        res.status(201).json({
            success: true,
            message: "Account created successfully! You can now log in.",
            userId: result.insertId
        });
    } catch (error) {
        console.error("Registration error:", error.message);

        if (error.code === "ER_DUP_ENTRY") {
            return res.status(409).json({
                success: false,
                message: "This email is already registered."
            });
        }

        res.status(500).json({
            success: false,
            message: "Registration failed. Check the server terminal."
        });
    }
});

// LOGIN
app.post("/api/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                success: false,
                message: "Enter your email and password."
            });
        }

        const [rows] = await pool.execute(
            `SELECT id, full_name, email, branch, semester,
                    interests, password
             FROM students WHERE email = ?`,
            [String(email).trim().toLowerCase()]
        );

        if (
            rows.length === 0 ||
            !(await bcrypt.compare(String(password), rows[0].password))
        ) {
            return res.status(401).json({
                success: false,
                message: "Incorrect email or password."
            });
        }

        const student = rows[0];

        res.json({
            success: true,
            message: "Login successful!",
            token: createToken(student),
            user: {
                id: student.id,
                fullName: student.full_name,
                email: student.email,
                branch: student.branch,
                semester: student.semester,
                interests: student.interests
            }
        });
    } catch (error) {
        console.error("Login error:", error.message);

        res.status(500).json({
            success: false,
            message: "Login failed. Check the server terminal."
        });
    }
});

// CURRENT USER
app.get("/api/me", requireLogin, async (req, res) => {
    try {
        const [rows] = await pool.execute(
            `SELECT id, full_name, email, branch, semester,
                    interests, created_at
             FROM students WHERE id = ?`,
            [req.user.id]
        );

        if (!rows.length) {
            return res.status(404).json({
                success: false,
                message: "Student not found."
            });
        }

        res.json({ success: true, user: rows[0] });
    } catch (error) {
        console.error("Profile error:", error.message);

        res.status(500).json({
            success: false,
            message: "Could not load profile."
        });
    }
});

// STUDENT DIRECTORY WITH ONLINE STATUS
app.get("/api/students", requireLogin, async (req, res) => {
    try {
        const query = String(req.query.q || "").trim();
        const search = `%${query}%`;

        const [students] = await pool.execute(
            `SELECT id, full_name, email, branch, semester, interests
             FROM students
             WHERE id <> ?
               AND (full_name LIKE ? OR branch LIKE ? OR interests LIKE ?)
             ORDER BY full_name`,
            [req.user.id, search, search, search]
        );

        res.json({
            success: true,
            students: students.map((student) => ({
                ...student,
                online: onlineStudents.has(Number(student.id))
            }))
        });
    } catch (error) {
        console.error("Student directory error:", error.message);

        res.status(500).json({
            success: false,
            message: "Could not load students."
        });
    }
});

// LOAD CHAT HISTORY
app.get("/api/messages/:friendId", requireLogin, async (req, res) => {
    try {
        const friendId = Number(req.params.friendId);
        console.log("DEBUG MESSAGE IDs:", {
            loggedInUserId: req.user.id,
            selectedFriendId: friendId
        });
        if (
            !Number.isInteger(friendId) ||
            friendId <= 0 ||
            friendId === req.user.id
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid student selected."
            });
        }

        const [students] = await pool.execute(
            "SELECT id FROM students WHERE id = ?",
            [friendId]
        );

        if (!students.length) {
            return res.status(404).json({
                success: false,
                message: "Student not found."
            });
        }

        const [messages] = await pool.execute(
            `SELECT id, sender_id, receiver_id, message, created_at
             FROM messages
             WHERE (sender_id = ? AND receiver_id = ?)
                OR (sender_id = ? AND receiver_id = ?)
             ORDER BY created_at ASC, id ASC`,
            [req.user.id, friendId, friendId, req.user.id]
        );

        res.json({
            success: true,
            my_id: req.user.id,
            messages
        });
    } catch (error) {
        console.error("Load messages error:", error.message);

        res.status(500).json({
            success: false,
            message: "Could not load messages."
        });
    }
});

// SEND AND BROADCAST MESSAGE
app.post("/api/messages/:friendId", requireLogin, async (req, res) => {
    try {
        const friendId = Number(req.params.friendId);
        const message = String(req.body.message || "").trim();

        if (
            !Number.isInteger(friendId) ||
            friendId <= 0 ||
            friendId === req.user.id
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid student selected."
            });
        }

        if (!message || message.length > 2000) {
            return res.status(400).json({
                success: false,
                message: "Message must contain 1–2000 characters."
            });
        }

        const [students] = await pool.execute(
            "SELECT id FROM students WHERE id = ?",
            [friendId]
        );

        if (!students.length) {
            return res.status(404).json({
                success: false,
                message: "Student not found."
            });
        }

        const [result] = await pool.execute(
            `INSERT INTO messages (sender_id, receiver_id, message)
             VALUES (?, ?, ?)`,
            [req.user.id, friendId, message]
        );

        const [savedMessages] = await pool.execute(
            `SELECT id, sender_id, receiver_id, message, created_at
             FROM messages WHERE id = ?`,
            [result.insertId]
        );

        const savedMessage = savedMessages[0];
        const room = [req.user.id, friendId]
            .sort((a, b) => a - b)
            .join(":");

        io.to(`chat:${room}`).emit("chat:message", savedMessage);

        res.status(201).json({
            success: true,
            message: "Message sent.",
            savedMessage
        });
    } catch (error) {
        console.error("Send message error:", error.message);

        res.status(500).json({
            success: false,
            message: "Could not send message."
        });
    }
});

// HOME PAGE
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "index.html"));
});

// START SERVER
async function startServer() {
    try {
        await pool.query("SELECT 1");

        await pool.execute(`
            CREATE TABLE IF NOT EXISTS messages (
                id INT AUTO_INCREMENT PRIMARY KEY,
                sender_id INT NOT NULL,
                receiver_id INT NOT NULL,
                message TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                FOREIGN KEY (sender_id)
                    REFERENCES students(id) ON DELETE CASCADE,
                FOREIGN KEY (receiver_id)
                    REFERENCES students(id) ON DELETE CASCADE
            )
        `);

        httpServer.listen(PORT, () => {
            console.log(
                `SAPTHA CONNECT running at http://localhost:${PORT}`
            );
            console.log("Database connection successful.");
            console.log("Socket.IO is ready.");
        });
    } catch (error) {
        console.error("Startup failed:", error.message);
        process.exit(1);
    }
}

startServer();
