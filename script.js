
document.addEventListener("DOMContentLoaded", () => {
    const $ = (id) => document.getElementById(id);
    const TOKEN_KEY = "sapthaConnectToken";

    const registerForm = $("registerForm");
    const loginForm = $("loginForm");
    const authCard = $("authSection") || document.querySelector(".auth-card");
    const communitySection = $("communitySection");

    let activeFriendId = null;
    let activeFriendName = "";
    let currentUser = null;
    let searchTimer = null;
    let socket = null;
    let onlineIds = new Set();
    let renderedMessageIds = new Set();

    function showMessage(id, text, type = "error") {
        const el = $(id);
        if (!el) return;
        el.textContent = text;
        el.className = `message ${type}`;
    }

    function switchTab(register) {
        registerForm.hidden = !register;
        loginForm.hidden = register;

        $("registerTab").classList.toggle("active", register);
        $("loginTab").classList.toggle("active", !register);
        $("registerTab").setAttribute("aria-selected", String(register));
        $("loginTab").setAttribute("aria-selected", String(!register));
    }

    function showLogin() {
        if (socket) {
            socket.disconnect();
            socket = null;
        }

        communitySection.hidden = true;
        authCard.hidden = false;
        switchTab(false);
    }

    function showCommunity() {
        authCard.hidden = true;
        communitySection.hidden = false;

        if ($("heroSection")) $("heroSection").hidden = true;
        if ($("featuresSection")) $("featuresSection").hidden = true;

        updateProfile();
        connectSocket();
        loadStudents();
    }

    function updateProfile() {
        if (!currentUser) return;

        $("profileName").textContent =
            currentUser.full_name || currentUser.fullName || "Student";

        $("profileEmail").textContent = currentUser.email || "";

        const avatar = $("profileAvatar");
        const savedPhoto = localStorage.getItem("sapthaConnectProfilePhoto");

        if (savedPhoto) {
            avatar.src = savedPhoto;
        } else {
            const initials = (
                currentUser.full_name || currentUser.fullName || "SC"
            )
                .trim()
                .split(/\s+/)
                .slice(0, 2)
                .map((part) => part[0])
                .join("")
                .toUpperCase();

            avatar.src =
                "https://placehold.co/100x100/242016/D4AF37?text=" +
                encodeURIComponent(initials || "SC");
        }
    }

    $("profilePhotoInput").addEventListener("change", (event) => {
        const file = event.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith("image/")) {
            showMessage("communityMessage", "Please select an image file.");
            event.target.value = "";
            return;
        }

        if (file.size > 2 * 1024 * 1024) {
            showMessage(
                "communityMessage",
                "Please choose a photo smaller than 2 MB."
            );
            event.target.value = "";
            return;
        }

        const reader = new FileReader();

        reader.onload = () => {
            try {
                localStorage.setItem(
                    "sapthaConnectProfilePhoto",
                    reader.result
                );

                $("profileAvatar").src = reader.result;
                showMessage(
                    "communityMessage",
                    "Profile photo updated on this browser.",
                    "success"
                );
            } catch {
                showMessage(
                    "communityMessage",
                    "Could not save the photo. Try a smaller image."
                );
            }
        };

        reader.onerror = () => {
            showMessage("communityMessage", "Could not read that image.");
        };

        reader.readAsDataURL(file);
    });

    async function readResponse(response) {
        const result = await response.json().catch(() => ({}));

        if (!response.ok || result.success === false) {
            throw new Error(result.message || `Error ${response.status}`);
        }

        return result;
    }

    async function apiRequest(url, options = {}) {
        const token = localStorage.getItem(TOKEN_KEY);

        const response = await fetch(url, {
            ...options,
            headers: {
                ...(options.headers || {}),
                ...(options.body
                    ? { "Content-Type": "application/json" }
                    : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {})
            }
        });

        if (response.status === 401) {
            localStorage.removeItem(TOKEN_KEY);
            currentUser = null;
            showLogin();
            throw new Error("Your session expired. Please log in again.");
        }

        return readResponse(response);
    }

    function addText(parent, text, tag = "p") {
        const el = document.createElement(tag);
        el.textContent = text ?? "";
        parent.appendChild(el);
        return el;
    }

    function makeButton(text, callback) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "primary-button";
        button.textContent = text;
        button.addEventListener("click", callback);
        return button;
    }

    // REAL-TIME CONNECTION
    function connectSocket() {
        const token = localStorage.getItem(TOKEN_KEY);
        if (!token || typeof window.io !== "function") {
            console.error(
                "Socket.IO client unavailable. Check the script tag in index.html."
            );
            showMessage(
                "communityMessage",
                "Live chat is unavailable. Check index.html for the Socket.IO script."
            );
            return;
        }

        if (socket) socket.disconnect();

        socket = window.io({
            auth: { token }
        });

        socket.on("connect", () => {
            console.log("SAPTHA CONNECT live chat connected.");

            if (activeFriendId !== null) {
                joinActiveChat();
            }
        });

        socket.on("connect_error", (error) => {
            console.error("Live chat connection:", error.message);
        });

        socket.on("presence:initial", (data) => {
            onlineIds = new Set((data.onlineIds || []).map(Number));
            updateOnlineIndicators();
        });

        socket.on("presence:update", (data) => {
            const id = Number(data.studentId);

            if (data.online) {
                onlineIds.add(id);
            } else {
                onlineIds.delete(id);
            }

            updateOnlineIndicators();
        });

        socket.on("chat:message", (message) => {
            if (activeFriendId === null) return;

            const senderId = Number(message.sender_id);
            const receiverId = Number(message.receiver_id);
            const me = Number(currentUser?.id || currentUser?.student_id);

            const belongsToCurrentChat =
                (senderId === me && receiverId === Number(activeFriendId)) ||
                (receiverId === me && senderId === Number(activeFriendId));

            if (belongsToCurrentChat) {
                appendMessage(message);
            }
        });
    }

    function joinActiveChat() {
        if (!socket || !socket.connected || activeFriendId === null) return;

        socket.emit("chat:join", activeFriendId, (result) => {
            if (!result?.success) {
                console.error(
                    "Could not join chat:",
                    result?.message || "Unknown error"
                );
            }
        });
    }

    function updateOnlineIndicators() {
        document.querySelectorAll("[data-student-id]").forEach((card) => {
            const id = Number(card.dataset.studentId);
            const isOnline = onlineIds.has(id);
            const dot = card.querySelector(".online-dot");
            const status = card.querySelector(".online-status");

            if (dot) {
                dot.style.backgroundColor = isOnline ? "#22c55e" : "#777";
                dot.title = isOnline ? "Online" : "Offline";
            }

            if (status) {
                status.textContent = isOnline ? "Online" : "Offline";
                status.style.color = isOnline ? "#22c55e" : "#999";
            }
        });

        if (activeFriendId !== null) {
            const status = $("chatOnlineStatus");
            if (status) {
                const isOnline = onlineIds.has(Number(activeFriendId));
                status.textContent = isOnline ? "● Online" : "○ Offline";
                status.style.color = isOnline ? "#22c55e" : "#999";
            }
        }
    }

    $("registerTab").addEventListener("click", () => switchTab(true));
    $("loginTab").addEventListener("click", () => switchTab(false));

    // REGISTER
    registerForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        const data = {
            fullName: $("fullName").value.trim(),
            email: $("registerEmail").value.trim(),
            branch: $("branch").value,
            semester: $("semester").value,
            interests: $("interests").value.trim(),
            password: $("registerPassword").value
        };

        const button = $("registerButton");
        button.disabled = true;

        try {
            const response = await fetch("/api/register", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(data)
            });

            const result = await readResponse(response);

            showMessage(
                "registerMessage",
                result.message || "Account created! Please log in.",
                "success"
            );

            registerForm.reset();
            switchTab(false);
        } catch (error) {
            showMessage("registerMessage", error.message);
        } finally {
            button.disabled = false;
        }
    });

    // LOGIN
    loginForm.addEventListener("submit", async (event) => {
        event.preventDefault();

        const button = $("loginButton");
        button.disabled = true;

        try {
            const response = await fetch("/api/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    email: $("loginEmail").value.trim(),
                    password: $("loginPassword").value
                })
            });

            const result = await readResponse(response);

            if (!result.token) {
                throw new Error("Login token missing from server response.");
            }

            localStorage.setItem(TOKEN_KEY, result.token);
            currentUser = result.user || null;

            try {
                const me = await apiRequest("/api/me");
                currentUser = me.user || me.student || currentUser;
            } catch (error) {
                if (!currentUser) throw error;
            }

            showCommunity();
        } catch (error) {
            showMessage("loginMessage", error.message);
        } finally {
            button.disabled = false;
        }
    });

    // STUDENT DIRECTORY
    async function loadStudents() {
        const list = $("studentList");
        list.replaceChildren();
        addText(list, "Loading registered students...");

        try {
            const query = $("studentSearch").value.trim();
            const result = await apiRequest(
                `/api/students?q=${encodeURIComponent(query)}`
            );

            list.replaceChildren();
            const students = result.students || [];

            if (students.length === 0) {
                addText(list, "No other registered students found.", "div")
                    .className = "empty-state";
                return;
            }

            students.forEach((student) => {
                const card = document.createElement("div");
                card.className = "student-item";
                card.dataset.studentId = student.id;

                const heading = document.createElement("div");
                heading.style.display = "flex";
                heading.style.alignItems = "center";
                heading.style.gap = "8px";

                addText(heading, student.full_name || "Student", "h4");

                const dot = document.createElement("span");
                dot.className = "online-dot";
                dot.style.cssText =
                    "display:inline-block;width:9px;height:9px;border-radius:50%;flex-shrink:0;";
                dot.style.backgroundColor =
                    student.online || onlineIds.has(Number(student.id))
                        ? "#22c55e"
                        : "#777";
                dot.title =
                    student.online || onlineIds.has(Number(student.id))
                        ? "Online"
                        : "Offline";

                heading.appendChild(dot);
                card.appendChild(heading);

                addText(
                    card,
                    [
                        student.branch,
                        student.semester
                            ? `Semester ${student.semester}`
                            : ""
                    ].filter(Boolean).join(" • ")
                );

                if (student.interests) {
                    addText(card, `Interests: ${student.interests}`);
                }

                const status = addText(
                    card,
                    student.online || onlineIds.has(Number(student.id))
                        ? "Online"
                        : "Offline",
                    "small"
                );
                status.className = "online-status";
                status.style.color =
                    student.online || onlineIds.has(Number(student.id))
                        ? "#22c55e"
                        : "#999";

                card.appendChild(
                    makeButton("Message", () => openChat(student))
                );

                list.appendChild(card);
            });

            updateOnlineIndicators();
        } catch (error) {
            list.replaceChildren();
            addText(list, error.message);
        }
    }

    $("studentSearch").addEventListener("input", () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(loadStudents, 250);
    });

    // OPEN CHAT
    async function openChat(student) {
        activeFriendId = Number(student.id);
        activeFriendName = student.full_name || "Student";
        renderedMessageIds = new Set();

        $("messagePanel").hidden = false;
        $("messageRecipient").textContent = `Chat with ${activeFriendName}`;

        let status = $("chatOnlineStatus");
        if (!status) {
            status = document.createElement("small");
            status.id = "chatOnlineStatus";
            $("messageRecipient").insertAdjacentElement("afterend", status);
        }

        updateOnlineIndicators();

        $("messageList").replaceChildren();

        joinActiveChat();
        await loadMessages();

        $("messageInput").focus();
    }

    // CREATE AND DISPLAY A MESSAGE
    function appendMessage(message) {
        if (!message) return;

        if (message.id != null) {
            const messageId = String(message.id);
            if (renderedMessageIds.has(messageId)) return;
            renderedMessageIds.add(messageId);
        }

        const list = $("messageList");
        const emptyState = list.querySelector(".empty-state");
        if (emptyState) emptyState.remove();

        const myId = Number(currentUser?.id || currentUser?.student_id);
        const isMine = Number(message.sender_id) === myId;

        const bubble = document.createElement("div");
        bubble.className = `chat-message${isMine ? " mine" : ""}`;

        const senderLabel = document.createElement("small");
        senderLabel.textContent = isMine ? "You" : activeFriendName;
        bubble.appendChild(senderLabel);

        const content = document.createElement("div");
        content.textContent = message.message || message.content || "";
        bubble.appendChild(content);

        if (message.created_at) {
            const time = document.createElement("small");
            time.textContent = new Date(message.created_at).toLocaleString();
            bubble.appendChild(time);
        }

        list.appendChild(bubble);
        list.scrollTop = list.scrollHeight;
    }

    // LOAD EXISTING CHAT HISTORY
    async function loadMessages() {
        if (activeFriendId === null) return;

        const requestedFriendId = Number(activeFriendId);
        const list = $("messageList");
        list.replaceChildren();
        renderedMessageIds = new Set();

        try {
            const result = await apiRequest(
                `/api/messages/${requestedFriendId}`
            );

            // Ignore stale results if the user opened another chat.
            if (Number(activeFriendId) !== requestedFriendId) return;

            const messages = result.messages || [];

            if (messages.length === 0) {
                const empty = addText(
                    list,
                    "No messages yet. Say hello!",
                    "div"
                );
                empty.className = "empty-state";
                return;
            }

            messages.forEach(appendMessage);
            list.scrollTop = list.scrollHeight;
        } catch (error) {
            if (Number(activeFriendId) !== requestedFriendId) return;
            list.replaceChildren();
            addText(list, error.message);
        }
    }

    // SEND MESSAGE
    $("messageForm").addEventListener("submit", async (event) => {
        event.preventDefault();

        if (activeFriendId === null) return;

        const friendId = Number(activeFriendId);
        const input = $("messageInput");
        const message = input.value.trim();

        if (!message) return;

        const button = $("messageForm").querySelector("button");
        button.disabled = true;

        try {
            await apiRequest(`/api/messages/${friendId}`, {
                method: "POST",
                body: JSON.stringify({ message })
            });

            input.value = "";

            // The server broadcasts the saved message over Socket.IO.
            // Reload history as a fallback if live connection is unavailable.
            if (!socket || !socket.connected) {
                await loadMessages();
            }

            showMessage("communityMessage", "Message sent.", "success");
        } catch (error) {
            showMessage("communityMessage", error.message);
        } finally {
            button.disabled = false;
            input.focus();
        }
    });

    // LOG OUT
    $("logoutButton").addEventListener("click", () => {
        if (socket) {
            socket.disconnect();
            socket = null;
        }

        localStorage.removeItem(TOKEN_KEY);
        currentUser = null;
        activeFriendId = null;
        activeFriendName = "";
        onlineIds = new Set();

        $("messagePanel").hidden = true;

        if ($("heroSection")) $("heroSection").hidden = false;
        if ($("featuresSection")) $("featuresSection").hidden = false;

        showLogin();
        showMessage("loginMessage", "Logged out successfully.", "success");
    });

    // RESTORE LOGIN SESSION
    async function restoreSession() {
        if (!localStorage.getItem(TOKEN_KEY)) return;

        try {
            const result = await apiRequest("/api/me");
            currentUser = result.user || result.student || result;
            showCommunity();
        } catch (error) {
            console.log("Session restore:", error.message);
        }
    }

    restoreSession();
});
