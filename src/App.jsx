import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { initializeApp } from 'firebase/app';
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from 'firebase/auth';
import {
  getFirestore,
  doc,
  setDoc,
  collection,
  query,
  onSnapshot,
  updateDoc,
  deleteDoc,
  where,
  getDoc, // <-- Imported getDoc for initial data check
  serverTimestamp,
  orderBy,
  addDoc,
  setLogLevel
} from 'firebase/firestore';

// --- Utility Functions ---

// 1. Firebase Initialization and Global Variables
const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = typeof __firebase_config !== 'undefined' ? JSON.parse(__firebase_config) : null;
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initial_auth_token : null;

// Helper to calculate payment based on the PDF logic, extended for other work types
const calculatePayment = (tasks, baseRatePerMinute) => {
    // --- Lecture (PDF Logic) ---
    let lectureBillableMinutes = 0;
    let lectureRatingSum = 0;
    let lectureRatingCount = 0;
    let lecturesCount = 0;
    
    // Grouping for Lecture Billable Minutes (T_billable) and Lecture Count
    const chapterData = tasks.reduce((acc, task) => {
        if (task.taskType !== 'Lecture' || !task.chapterName || !task.minutes || task.minutes <= 0) {
            return acc;
        }
        if (!acc[task.chapterName]) {
            acc[task.chapterName] = { totalMinutes: 0, ratings: [], lectureCount: 0 };
        }
        acc[task.chapterName].totalMinutes += task.minutes;
        if (task.rating) {
            acc[task.chapterName].ratings.push(task.rating);
        }
        acc[task.chapterName].lectureCount += 1;
        return acc;
    }, {});
    
    // Final aggregation for Lectures
    for (const chapter in chapterData) {
        const data = chapterData[chapter];
        lectureBillableMinutes += Math.min(data.totalMinutes, 240);
        lecturesCount += data.lectureCount;
        lectureRatingSum += data.ratings.reduce((sum, r) => sum + r, 0);
        lectureRatingCount += data.ratings.length;
    }


    const R_minute = baseRatePerMinute || 10; // Defaulting to 10 rs/min as per example

    // Base Pay for Lectures
    const basePayLectures = lectureBillableMinutes * R_minute;

    // M_rate (Quality Modifier) for Lectures
    const averageRating = lectureRatingCount > 0 ? lectureRatingSum / lectureRatingCount : 5.0; // Assume 5.0 if no rating
    let M_rate = 1.0;
    if (averageRating < 2.5) {
        M_rate = 0.6;
    } else if (averageRating <= 3.5) {
        M_rate = 0.75;
    } else {
        M_rate = 1.0;
    }

    // M_freq (Frequency & Volume Modifier) for Lectures
    let M_freq = 1.0;
    if (lecturesCount >= 3 && lectureBillableMinutes >= 180) {
        M_freq = 1.2; // Bonus
    } else if (lecturesCount >= 2 && lectureBillableMinutes >= 120) {
        M_freq = 1.0; // Standard
    } else if (lecturesCount < 2 || lectureBillableMinutes < 120) {
        M_freq = 0.8; // Penalty
    }

    // Final Payment for Lectures
    const P_final_lectures = basePayLectures * M_rate * M_freq;
    
    
    // --- Other Work (Chapter/Unit Based) ---
    
    // Placeholder rate for non-lecture tasks (Assumes 500 Rs per chapter/unit completed)
    const CHAPTER_RATE = 500; 

    const nonLectureTasks = tasks.filter(t => t.taskType !== 'Lecture');
    
    let totalChaptersCompleted = 0;
    let P_final_other = 0;
    
    nonLectureTasks.forEach(task => {
        const chapters = task.chaptersCompleted || 0;
        totalChaptersCompleted += chapters;
        
        // Simple linear payment based on chapters completed
        P_final_other += chapters * CHAPTER_RATE; 
    });
    
    // --- Combined Totals ---
    const P_final = P_final_lectures + P_final_other;


    return {
        P_final: Math.round(P_final),
        P_final_lectures: Math.round(P_final_lectures),
        P_final_other: Math.round(P_final_other),
        T_billable: lectureBillableMinutes,
        totalChaptersCompleted,
        R_minute,
        M_rate,
        M_freq,
        averageRating: averageRating.toFixed(2),
        lecturesCount,
        basePayLectures: Math.round(basePayLectures),
        CHAPTER_RATE
    };
};

// --- Custom Components ---

const Panel = ({ title, children, className = '' }) => (
    <div className={`bg-white shadow-xl rounded-xl p-6 ${className}`}>
        <h2 className="text-xl font-bold text-indigo-800 mb-4 border-b pb-2">{title}</h2>
        {children}
    </div>
);

const Button = ({ children, onClick, disabled = false, className = 'bg-indigo-600 hover:bg-indigo-700' }) => (
    <button
        onClick={onClick}
        disabled={disabled}
        className={`py-2 px-4 rounded-lg text-white font-semibold transition duration-150 ${className} ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
    >
        {children}
    </button>
);

// --- Main App Component ---

const App = () => {
    // 1. FIREBASE STATE
    const [db, setDb] = useState(null);
    const [auth, setAuth] = useState(null);
    const [userId, setUserId] = useState(null);
    const [isAuthReady, setIsAuthReady] = useState(false);
    const [isLoading, setIsLoading] = useState(true);
    const [error, setError] = useState('');

    // 2. APPLICATION DATA STATE
    const [mentors, setMentors] = useState([]);
    const [tasks, setTasks] = useState([]);
    const defaultTeams = useMemo(() => ([
        'Lecture Team',
        'Content Team (Chapterwise)',
        'Test Series Team',
        'Doubt Session Team',
        'Mentorship Team',
    ]), []);
    const [teams, setTeams] = useState(defaultTeams);
    const [baseRatePerMinute, setBaseRatePerMinute] = useState(10); // Not currently stored in DB, but defaulted here

    // 3. UI STATE
    const [activeTab, setActiveTab] = useState('dashboard'); // dashboard, mentors, teams, tasks
    const [selectedMentor, setSelectedMentor] = useState(null);
    const [showMentorModal, setShowMentorModal] = useState(false);
    const [showTeamModal, setShowTeamModal] = useState(false);
    const [newTeamName, setNewTeamName] = useState('');
    const [currentMentorData, setCurrentMentorData] = useState({
        name: '',
        email: '',
        baseRate: 10,
        teams: [],
        photoURL: 'https://placehold.co/100x100/4F46E5/FFFFFF?text=P4I',
    });
    // This hook state was causing the hook order issue and must be declared at the top level
    const [taskMentor, setTaskMentor] = useState(null); 

    // --- FIREBASE INITIALIZATION & AUTH ---
    useEffect(() => {
        // Enable Firebase debug logging for better error visibility
        setLogLevel('debug');
        
        if (!firebaseConfig) {
            setError("Firebase configuration is missing.");
            setIsLoading(false);
            return;
        }

        try {
            const app = initializeApp(firebaseConfig);
            const firestore = getFirestore(app);
            const authInstance = getAuth(app);

            setDb(firestore);
            setAuth(authInstance);

            const unsubscribe = onAuthStateChanged(authInstance, async (user) => {
                if (user) {
                    setUserId(user.uid);
                } else if (!user) {
                    // Sign in anonymously if no token is available or initial state is empty
                    await signInAnonymously(authInstance);
                }
                setIsAuthReady(true);
                setIsLoading(false);
            });

            // Handle custom token sign-in
            const handleSignIn = async () => {
                try {
                    if (initialAuthToken) {
                        await signInWithCustomToken(authInstance, initialAuthToken);
                    }
                } catch (e) {
                    console.error("Custom token sign-in failed, falling back to anonymous:", e);
                    await signInAnonymously(authInstance);
                }
            };

            if (!initialAuthToken) {
                // If no token, use the onAuthStateChanged flow which includes anonymous sign-in
            } else {
                handleSignIn();
            }

            return () => unsubscribe();
        } catch (e) {
            console.error("Firebase Initialization Error:", e);
            setError("Failed to initialize Firebase services.");
            setIsLoading(false);
        }
    }, []);

    // --- FIRESTORE DATA LISTENERS ---
    useEffect(() => {
        // IMPORTANT: Prevent Firestore queries before authentication is confirmed
        if (!db || !isAuthReady || !userId) {
            console.log("Waiting for DB or Auth readiness. DB:", !!db, "AuthReady:", isAuthReady, "UserID:", !!userId);
            return;
        }
        console.log("Authentication complete. Attaching Firestore listeners.");

        const pathPrefix = `/artifacts/${appId}/public/data`;

        // 1. Teams Listener (Public Data)
        const teamsRef = doc(db, `${pathPrefix}/settings/teams`);
        
        // Attempt to create default teams data if it doesn't exist (robustness addition)
        const checkAndSetDefaultTeams = async () => {
             try {
                const docSnap = await getDoc(teamsRef);
                if (!docSnap.exists()) {
                    console.log("Teams document missing. Attempting to write default teams.");
                    await setDoc(teamsRef, { list: defaultTeams, lastUpdated: serverTimestamp() });
                }
            } catch (e) {
                // This is expected to fail if permissions are missing for both read (getDoc) and write (setDoc)
                console.error("Failed to check/set default teams (likely permission issue):", e);
            }
        }
        checkAndSetDefaultTeams();


        const unsubscribeTeams = onSnapshot(teamsRef, (docSnap) => {
            if (docSnap.exists() && docSnap.data().list) {
                setTeams(docSnap.data().list);
            }
        }, (err) => console.error("Teams Snapshot Error:", err));

        // 2. Mentors Listener (Public Data)
        const mentorsRef = collection(db, `${pathPrefix}/mentors`);
        const unsubscribeMentors = onSnapshot(mentorsRef, (snapshot) => {
            const mentorList = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                teams: doc.data().teams || []
            }));
            setMentors(mentorList);
        }, (err) => console.error("Mentors Snapshot Error:", err));

        // 3. Tasks Listener (Public Data)
        const tasksRef = collection(db, `${pathPrefix}/tasks`);
        // Note: Using client-side sorting for simplicity, but Firestore query is also possible
        const unsubscribeTasks = onSnapshot(tasksRef, (snapshot) => {
            const taskList = snapshot.docs.map(doc => ({
                id: doc.id,
                ...doc.data(),
                date: doc.data().date?.toDate() // Convert Firestore Timestamp to Date
            }));
            setTasks(taskList.sort((a, b) => b.date - a.date)); // Sort descending by date
        }, (err) => console.error("Tasks Snapshot Error:", err));

        return () => {
            unsubscribeTeams();
            unsubscribeMentors();
            unsubscribeTasks();
        };
    }, [db, isAuthReady, userId, defaultTeams]);


    // --- CRUD Operations ---

    // Save Teams List (Public Data)
    const saveTeams = useCallback(async (newTeams) => {
        if (!db || !userId) return;
        try {
            const teamsRef = doc(db, `/artifacts/${appId}/public/data/settings/teams`);
            await setDoc(teamsRef, { list: newTeams, lastUpdated: serverTimestamp() });
            setTeams(newTeams);
            setNewTeamName('');
        } catch (e) {
            console.error("Error saving teams:", e);
            setError("Failed to save teams.");
        }
    }, [db, userId]);

    // Handle Team Edit/Add
    const handleAddTeam = () => {
        if (newTeamName && !teams.includes(newTeamName)) {
            saveTeams([...teams, newTeamName]);
        }
    };
    const handleDeleteTeam = (teamToDelete) => {
        const newTeams = teams.filter(t => t !== teamToDelete);
        saveTeams(newTeams);
        // Also update mentors who might have this team selected
        mentors.forEach(mentor => {
            if (mentor.teams.includes(teamToDelete)) {
                updateMentor({ ...mentor, teams: mentor.teams.filter(t => t !== teamToDelete) });
            }
        });
    };

    // Add/Update Mentor (Public Data)
    const updateMentor = useCallback(async (mentorData) => {
        if (!db || !userId) return;
        try {
            const mentorRef = doc(db, `/artifacts/${appId}/public/data/mentors/${mentorData.id || crypto.randomUUID()}`);
            await setDoc(mentorRef, {
                name: mentorData.name,
                email: mentorData.email,
                baseRate: mentorData.baseRate || 10,
                teams: mentorData.teams || [],
                photoURL: mentorData.photoURL || 'https://placehold.co/100x100/4F46E5/FFFFFF?text=P4I',
                lastUpdated: serverTimestamp()
            }, { merge: true });
            setShowMentorModal(false);
        } catch (e) {
            console.error("Error saving mentor:", e);
            setError("Failed to save mentor.");
        }
    }, [db, userId]);

    // Delete Mentor (Public Data)
    const deleteMentor = useCallback(async (mentorId) => {
        // IMPORTANT: Replace window.confirm with custom modal in production
        if (!db || !userId || !window.confirm("Are you sure you want to delete this mentor and all their associated tasks?")) return; 
        try {
            // Delete mentor
            await deleteDoc(doc(db, `/artifacts/${appId}/public/data/mentors/${mentorId}`));

            // Delete associated tasks (batch delete is better, but this is simpler)
            const tasksToDelete = tasks.filter(t => t.mentorId === mentorId);
            for (const task of tasksToDelete) {
                await deleteDoc(doc(db, `/artifacts/${appId}/public/data/tasks/${task.id}`));
            }

            console.log(`Mentor ${mentorId} and ${tasksToDelete.length} tasks deleted.`);
        } catch (e) {
            console.error("Error deleting mentor:", e);
            setError("Failed to delete mentor.");
        }
    }, [db, userId, tasks]);

    // Add Task (Public Data)
    const addTask = useCallback(async (taskData) => {
        if (!db || !userId) return;
        try {
            await addDoc(collection(db, `/artifacts/${appId}/public/data/tasks`), {
                ...taskData,
                date: serverTimestamp(), // Use server timestamp for consistent ordering
                submittedBy: userId,
            });
        } catch (e) {
            console.error("Error adding task:", e);
            setError("Failed to add task.");
        }
    }, [db, userId]);


    // --- View/UI Handlers ---

    const handleEditMentor = (mentor) => {
        setCurrentMentorData(mentor);
        setShowMentorModal(true);
    };

    const handleNewMentor = () => {
        setCurrentMentorData({
            name: '',
            email: '',
            baseRate: baseRatePerMinute,
            teams: [],
            photoURL: 'https://placehold.co/100x100/4F46E5/FFFFFF?text=P4I',
        });
        setShowMentorModal(true);
    };

    const handlePhotoUpload = (e) => {
        const file = e.target.files[0];
        if (file) {
            // NOTE: In a production environment, you would upload this to Firebase Storage
            // and get a URL. Here, we use a simple FileReader to show a local preview.
            const reader = new FileReader();
            reader.onloadend = () => {
                setCurrentMentorData(prev => ({ ...prev, photoURL: reader.result }));
            };
            reader.readAsDataURL(file);
        }
    };

    const handlePrint = (elementId) => {
        const printContent = document.getElementById(elementId).innerHTML;
        const originalContent = document.body.innerHTML;
        document.body.innerHTML = `
            <html>
                <head>
                    <title>PREP4IISER Printout</title>
                    <style>
                        body { font-family: sans-serif; padding: 20px; }
                        h1, h2, h3 { color: #4F46E5; }
                        .print-only-container { margin: 0 auto; max-width: 800px; }
                        /* Tailwind emulation for print */
                        .bg-indigo-50 { background-color: #EEF2FF; }
                        .shadow-md { box-shadow: 0 4px 6px -1px rgba(0, 0, 0, 0.1), 0 2px 4px -2px rgba(0, 0, 0, 0.1); }
                        .p-4 { padding: 1rem; }
                        .mb-4 { margin-bottom: 1rem; }
                        .text-lg { font-size: 1.125rem; }
                        .font-semibold { font-weight: 600; }
                        .border-b { border-bottom: 1px solid #E5E7EB; }
                        .py-2 { padding-top: 0.5rem; padding-bottom: 0.5rem; }
                        .flex { display: flex; }
                        .justify-between { justify-content: space-between; }
                        .w-full { width: 100%; }
                        .text-sm { font-size: 0.875rem; }
                        .text-gray-600 { color: #4B5563; }
                        .rounded-lg { border-radius: 0.5rem; }
                        .ring-2 { border: 2px solid; }
                        .ring-indigo-300 { border-color: #A5B4FC; }
                    </style>
                </head>
                <body>
                    <div class="print-only-container">
                        ${printContent}
                    </div>
                </body>
            </html>
        `;
        window.print();
        document.body.innerHTML = originalContent;
        // Reload to restore React state (necessary due to innerHTML replacement)
        window.location.reload();
    };

    // --- Data Processing & Aggregation ---

    const dashboardSummary = useMemo(() => {
        const totalMentors = mentors.length;
        const totalTasks = tasks.length;
        const totalLectures = tasks.filter(t => t.taskType === 'Lecture').length;
        const totalMinutes = tasks.filter(t => t.taskType === 'Lecture').reduce((sum, t) => sum + (t.minutes || 0), 0);
        
        // Aggregate all chapters/units completed across all mentors for non-lecture tasks
        const totalUnits = tasks.filter(t => t.taskType !== 'Lecture').reduce((sum, t) => sum + (t.chaptersCompleted || 0), 0);


        const mentorPayments = mentors.map(mentor => {
            const mentorTasks = tasks.filter(t => t.mentorId === mentor.id);
            // Pass mentor.baseRate to the calculation
            const { P_final } = calculatePayment(mentorTasks, mentor.baseRate); 
            return {
                mentorName: mentor.name,
                payment: P_final,
            };
        });

        const totalPayments = mentorPayments.reduce((sum, p) => sum + p.payment, 0);

        return {
            totalMentors,
            totalTasks,
            totalLectures,
            totalMinutes,
            totalUnits,
            totalPayments,
            mentorPayments,
        };
    }, [mentors, tasks]);


    // --- UI Renderers ---

    if (isLoading) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-gray-50">
                <div className="text-xl font-medium text-indigo-600">Loading PREP4IISER System...</div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex items-center justify-center min-h-screen bg-red-50 text-red-700 p-8">
                <p>Error: {error}</p>
            </div>
        );
    }

    // A. Mentor Modal (Add/Edit)
    const MentorModal = ({ mentor, onClose }) => {
        const isEditing = !!mentor.id;
        const [formData, setFormData] = useState(mentor);

        const handleChange = (e) => {
            const { name, value, type, checked } = e.target;
            setFormData(prev => ({
                ...prev,
                [name]: type === 'number' ? parseFloat(value) : value,
            }));
        };

        const handleTeamToggle = (teamName) => {
            setFormData(prev => {
                const newTeams = prev.teams.includes(teamName)
                    ? prev.teams.filter(t => t !== teamName)
                    : [...prev.teams, teamName];
                return { ...prev, teams: newTeams };
            });
        };

        const handleSubmit = (e) => {
            e.preventDefault();
            updateMentor(formData);
        };

        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 animate-fade-in">
                    <h3 className="text-2xl font-bold text-indigo-800 mb-6 border-b pb-3">{isEditing ? 'Edit Mentor' : 'Add New Mentor'}</h3>
                    <form onSubmit={handleSubmit}>
                        <div className="space-y-4">
                            {/* Photo Upload */}
                            <div className="flex flex-col items-center">
                                <img
                                    src={formData.photoURL}
                                    alt="Mentor Photo"
                                    className="w-24 h-24 rounded-full object-cover ring-4 ring-indigo-300 shadow-md mb-3"
                                />
                                <input
                                    type="file"
                                    id="photo-upload"
                                    accept="image/*"
                                    onChange={handlePhotoUpload}
                                    className="hidden"
                                />
                                <label
                                    htmlFor="photo-upload"
                                    className="cursor-pointer text-sm text-indigo-600 font-medium hover:text-indigo-800 transition"
                                >
                                    Change Photo
                                </label>
                            </div>

                            <label className="block">
                                <span className="text-gray-700 font-medium">Name:</span>
                                <input
                                    type="text"
                                    name="name"
                                    value={formData.name}
                                    onChange={handleChange}
                                    required
                                    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500"
                                />
                            </label>

                            <label className="block">
                                <span className="text-gray-700 font-medium">Email:</span>
                                <input
                                    type="email"
                                    name="email"
                                    value={formData.email}
                                    onChange={handleChange}
                                    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500"
                                />
                            </label>

                            <label className="block">
                                <span className="text-gray-700 font-medium">Base Rate (Rs/min):</span>
                                <input
                                    type="number"
                                    name="baseRate"
                                    value={formData.baseRate}
                                    onChange={handleChange}
                                    min="1"
                                    step="0.01"
                                    required
                                    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500"
                                />
                            </label>

                            <div className="mt-4">
                                <span className="text-gray-700 font-medium block mb-2">Teams: (Select all that apply)</span>
                                <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto p-2 border rounded-lg bg-gray-50">
                                    {teams.map(team => (
                                        <div
                                            key={team}
                                            onClick={() => handleTeamToggle(team)}
                                            className={`cursor-pointer px-3 py-1 text-sm rounded-full transition duration-150 ${
                                                formData.teams.includes(team)
                                                    ? 'bg-indigo-600 text-white shadow-md'
                                                    : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                                            }`}
                                        >
                                            {team}
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>

                        <div className="flex justify-end space-x-3 mt-6">
                            <Button type="button" onClick={onClose} className="bg-gray-500 hover:bg-gray-600">
                                Cancel
                            </Button>
                            {isEditing && (
                                <Button type="button" onClick={() => deleteMentor(mentor.id)} className="bg-red-500 hover:bg-red-600">
                                    Delete
                                </Button>
                            )}
                            <Button type="submit">
                                {isEditing ? 'Save Changes' : 'Add Mentor'}
                            </Button>
                        </div>
                    </form>
                </div>
            </div>
        );
    };

    // B. Teams Modal (Add/Edit)
    const TeamsModal = ({ onClose }) => {
        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 animate-fade-in">
                    <h3 className="text-2xl font-bold text-indigo-800 mb-6 border-b pb-3">Manage Teams/Roles</h3>

                    {/* Add New Team */}
                    <div className="mb-6 border p-4 rounded-lg bg-indigo-50">
                        <h4 className="font-semibold text-lg mb-2 text-indigo-700">Add New Category</h4>
                        <div className="flex space-x-2">
                            <input
                                type="text"
                                value={newTeamName}
                                onChange={(e) => setNewTeamName(e.target.value)}
                                placeholder="e.g., Curriculum Design"
                                className="flex-grow rounded-lg border-gray-300 shadow-sm p-2 border focus:ring-indigo-500 focus:border-indigo-500"
                            />
                            <Button onClick={handleAddTeam} disabled={!newTeamName}>
                                Add
                            </Button>
                        </div>
                    </div>

                    {/* Current Teams List */}
                    <div className="max-h-64 overflow-y-auto">
                        <h4 className="font-semibold text-lg mb-3">Current Teams ({teams.length})</h4>
                        <div className="space-y-2">
                            {teams.map(team => (
                                <div key={team} className="flex justify-between items-center bg-gray-100 p-3 rounded-lg shadow-sm">
                                    <span className="font-medium text-gray-800">{team}</span>
                                    <Button
                                        onClick={() => handleDeleteTeam(team)}
                                        className="bg-red-500 hover:bg-red-600 px-3 py-1 text-sm"
                                    >
                                        Delete
                                    </Button>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="flex justify-end mt-6">
                        <Button onClick={onClose} className="bg-indigo-600 hover:bg-indigo-700">
                            Done
                        </Button>
                    </div>
                </div>
            </div>
        );
    };

    // C. Task/Work Submission Modal
    const TaskModal = ({ mentor, onClose }) => {
        const [formData, setFormData] = useState({
            mentorId: mentor.id,
            mentorName: mentor.name,
            taskType: 'Lecture',
            description: '',
            chapterName: '', // Required for Lecture cap calculation
            minutes: 0, // Required for Lecture payment
            chaptersCompleted: 1, // New field for non-lecture tasks
            rating: 5.0,
            status: 'Done',
        });

        const handleChange = (e) => {
            const { name, value, type } = e.target;
            setFormData(prev => ({
                ...prev,
                [name]: type === 'number' ? parseFloat(value) : value,
            }));
        };

        const handleSubmit = (e) => {
            e.preventDefault();
            
            // Basic validation
            if (formData.taskType === 'Lecture' && (!formData.chapterName || formData.minutes <= 0)) {
                console.error("Validation Failed: For 'Lecture' tasks, Chapter Name and Minutes must be specified.");
                return;
            }
            if (formData.taskType !== 'Lecture' && formData.chaptersCompleted <= 0) {
                 console.error("Validation Failed: For non-lecture tasks, Chapters Completed must be greater than zero.");
                return;
            }
            
            addTask(formData);
            onClose();
        };

        const isLecture = formData.taskType === 'Lecture';
        const isChapterBased = formData.taskType === 'Content Team (Chapterwise)' || formData.taskType === 'Test Series Team';


        return (
            <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
                <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg p-6 animate-fade-in">
                    <h3 className="text-2xl font-bold text-indigo-800 mb-6 border-b pb-3">Submit Work for {mentor.name}</h3>
                    <form onSubmit={handleSubmit}>
                        <div className="space-y-4">
                            <label className="block">
                                <span className="text-gray-700 font-medium">Task Type:</span>
                                <select
                                    name="taskType"
                                    value={formData.taskType}
                                    onChange={handleChange}
                                    required
                                    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500"
                                >
                                    <option value="Lecture">Lecture</option>
                                    <option value="Content Team (Chapterwise)">Content (Q-Set/Chapter)</option>
                                    <option value="Test Series Team">Test Series (Unit/Module)</option>
                                    <option value="Doubt Session Team">Doubt Session</option>
                                    <option value="Mentorship Team">Mentorship</option>
                                    <option value="Other">Other</option>
                                </select>
                            </label>

                            <label className="block">
                                <span className="text-gray-700 font-medium">Description/Title of Work:</span>
                                <input
                                    type="text"
                                    name="description"
                                    value={formData.description}
                                    onChange={handleChange}
                                    required
                                    className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500"
                                />
                            </label>

                            {isLecture && (
                                <>
                                    <label className="block">
                                        <span className="text-gray-700 font-medium">Chapter Name (for cap):</span>
                                        <input
                                            type="text"
                                            name="chapterName"
                                            value={formData.chapterName}
                                            onChange={handleChange}
                                            required
                                            placeholder="e.g., Modern Physics"
                                            className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500"
                                        />
                                        <p className="text-xs text-gray-500 mt-1">Required for payment calculation (240 min cap per chapter).</p>
                                    </label>
                                    <label className="block">
                                        <span className="text-gray-700 font-medium">Minutes Delivered:</span>
                                        <input
                                            type="number"
                                            name="minutes"
                                            value={formData.minutes}
                                            onChange={handleChange}
                                            min="0"
                                            required
                                            className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500"
                                        />
                                        <p className="text-xs text-gray-500 mt-1">Used for T_billable calculation.</p>
                                    </label>
                                </>
                            )}
                            
                            {!isLecture && (
                                <label className="block">
                                    <span className="text-gray-700 font-medium">Chapters/Units Completed:</span>
                                    <input
                                        type="number"
                                        name="chaptersCompleted"
                                        value={formData.chaptersCompleted}
                                        onChange={handleChange}
                                        min="1"
                                        required
                                        className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500"
                                    />
                                    <p className="text-xs text-gray-500 mt-1">Used for payment calculation (Rs {calculatePayment([], mentor.baseRate).CHAPTER_RATE} per unit).</p>
                                </label>
                            )}


                            {isLecture && (
                                <label className="block">
                                    <span className="text-gray-700 font-medium">Rating (1.0 to 5.0):</span>
                                    <input
                                        type="number"
                                        name="rating"
                                        value={formData.rating}
                                        onChange={handleChange}
                                        min="1"
                                        max="5"
                                        step="0.1"
                                        required
                                        className="mt-1 block w-full rounded-lg border-gray-300 shadow-sm p-3 border focus:ring-indigo-500 focus:border-indigo-500"
                                    />
                                    <p className="text-xs text-gray-500 mt-1">Used for Quality Modifier (M_rate).</p>
                                </label>
                            )}

                        </div>

                        <div className="flex justify-end space-x-3 mt-6">
                            <Button type="button" onClick={onClose} className="bg-gray-500 hover:bg-gray-600">
                                Cancel
                            </Button>
                            <Button type="submit">
                                Submit Work
                            </Button>
                        </div>
                    </form>
                </div>
            </div>
        );
    };

    // D. Mentor Profile View
    const MentorProfile = ({ mentor, onBack }) => {
        const mentorTasks = tasks.filter(t => t.mentorId === mentor.id);

        // 90 Day Summary
        const ninetyDaysAgo = new Date();
        ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
        const tasksLast90Days = mentorTasks.filter(t => t.date && t.date > ninetyDaysAgo);

        // Calculate Payment Summary for 90 days
        const summary90Days = calculatePayment(tasksLast90Days, mentor.baseRate);
        const overallSummary = calculatePayment(mentorTasks, mentor.baseRate);

        // Group tasks by week for payment slip view
        const tasksByWeek = tasksLast90Days.reduce((acc, task) => {
            if (!task.date) return acc;
            // Simple weekly grouping: based on the start of the week for the task date (e.g., Monday)
            const date = new Date(task.date);
            const day = date.getDay(); // 0 is Sunday, 1 is Monday...
            const diff = date.getDate() - day + (day === 0 ? -6 : 1); // Adjust to Monday
            const weekStart = new Date(date.setDate(diff)).toISOString().split('T')[0];

            if (!acc[weekStart]) {
                acc[weekStart] = [];
            }
            acc[weekStart].push(task);
            return acc;
        }, {});

        return (
            <div className="p-6">
                <div className="flex justify-between items-center mb-6">
                    <Button onClick={onBack} className="bg-gray-500 hover:bg-gray-600 text-sm">
                        &larr; Back to Mentors
                    </Button>
                    <Button
                        onClick={() => handlePrint('mentor-profile-print')}
                        className="bg-green-600 hover:bg-green-700 text-sm"
                    >
                        Print Mentor Profile & Payment Slip
                    </Button>
                </div>

                <div id="mentor-profile-print" className="space-y-8 print-friendly">
                    {/* Mentor Header Section */}
                    <Panel title="Mentor Profile" className="col-span-1 md:col-span-3">
                        <div className="flex flex-col md:flex-row items-start md:items-center space-y-4 md:space-y-0 md:space-x-6">
                            <img
                                src={mentor.photoURL}
                                alt={`${mentor.name} Photo`}
                                className="w-24 h-24 rounded-full object-cover ring-4 ring-indigo-300 shadow-lg flex-shrink-0"
                            />
                            <div>
                                <h1 className="text-3xl font-extrabold text-gray-900">{mentor.name}</h1>
                                <p className="text-indigo-600 font-medium">{mentor.email}</p>
                                <p className="text-sm text-gray-500 mt-1">
                                    **User ID (for cross-reference):** <code className="text-xs bg-gray-100 p-1 rounded">{mentor.id}</code>
                                </p>
                            </div>
                        </div>
                        <div className="mt-4 pt-4 border-t">
                            <h4 className="font-semibold text-gray-700 mb-2">Assigned Teams/Roles:</h4>
                            <div className="flex flex-wrap gap-2">
                                {mentor.teams.map(team => (
                                    <span key={team} className="bg-indigo-100 text-indigo-700 px-3 py-1 text-sm rounded-full font-medium">
                                        {team}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </Panel>

                    {/* Summary Section */}
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                        <div className="bg-indigo-50 p-4 rounded-xl shadow-md">
                            <p className="text-lg font-semibold text-indigo-800">Overall Lectures</p>
                            <p className="text-3xl font-bold text-indigo-600">{overallSummary.lecturesCount}</p>
                        </div>
                        <div className="bg-indigo-50 p-4 rounded-xl shadow-md">
                            <p className="text-lg font-semibold text-indigo-800">Overall Chapters/Units</p>
                            <p className="text-3xl font-bold text-indigo-600">{overallSummary.totalChaptersCompleted}</p>
                        </div>
                        <div className="bg-green-50 p-4 rounded-xl shadow-md">
                            <p className="text-lg font-semibold text-green-800">Total Est. Pay (Overall)</p>
                            <p className="text-3xl font-bold text-green-600">Rs {overallSummary.P_final.toLocaleString()}</p>
                        </div>
                        <div className="bg-yellow-50 p-4 rounded-xl shadow-md">
                            <p className="text-lg font-semibold text-yellow-800">Overall Avg. Rating (Lec.)</p>
                            <p className="text-3xl font-bold text-yellow-600">{overallSummary.averageRating} / 5.0</p>
                        </div>
                    </div>

                    {/* Payment Slip/Details for Last 90 Days */}
                    <Panel title="Payment Summary (Last 90 Days)">
                        <p className="text-sm text-gray-600 mb-4">
                            This summary covers all tasks submitted from {ninetyDaysAgo.toLocaleDateString()} to present.
                        </p>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            {/* Combined Payout */}
                            <div className="space-y-2 p-4 bg-indigo-100 rounded-lg border-2 border-indigo-400 md:col-span-3">
                                <p className="text-xl font-extrabold text-indigo-900">FINAL 90-DAY PAYMENT: Rs {summary90Days.P_final.toLocaleString()}</p>
                                <p className="text-sm text-gray-700">
                                    <span className="font-semibold">Lecture Pay:</span> Rs {summary90Days.P_final_lectures.toLocaleString()} + <span className="font-semibold">Content/Other Pay:</span> Rs {summary90Days.P_final_other.toLocaleString()}
                                </p>
                            </div>

                            {/* Lecture Calculation Breakdown */}
                            <div className="space-y-2 p-4 bg-gray-50 rounded-lg border">
                                <h4 className="font-bold text-indigo-700">Lecture Work Breakdown (90 Days)</h4>
                                <p className="text-sm"><span className="font-semibold">Total Billable Minutes (Capped):</span> {summary90Days.T_billable} min</p>
                                <p className="text-sm"><span className="font-semibold">Base Pay (Rs {summary90Days.R_minute}/min):</span> Rs {summary90Days.basePayLectures.toLocaleString()}</p>
                                <p className="text-sm"><span className="font-semibold">Avg. Rating:</span> {summary90Days.averageRating}</p>
                                <p className="text-sm"><span className="font-semibold">Quality (M_rate):</span> {summary90Days.M_rate}</p>
                                <p className="text-sm"><span className="font-semibold">Frequency (M_freq):</span> {summary90Days.M_freq}</p>
                            </div>

                            {/* Content/Other Calculation Breakdown */}
                            <div className="space-y-2 p-4 bg-gray-50 rounded-lg border">
                                <h4 className="font-bold text-indigo-700">Content/Other Work Breakdown (90 Days)</h4>
                                <p className="text-sm"><span className="font-semibold">Total Chapters/Units:</span> {summary90Days.totalChaptersCompleted}</p>
                                <p className="text-sm"><span className="font-semibold">Rate per Unit (Placeholder):</span> Rs {summary90Days.CHAPTER_RATE}</p>
                                <p className="text-sm"><span className="font-semibold">Total Payout:</span> Rs {summary90Days.P_final_other.toLocaleString()}</p>
                                <p className="text-xs text-red-500 mt-2">Note: Rate is a placeholder; adjust policy.</p>
                            </div>
                        </div>
                    </Panel>

                    {/* Work Assigned/Done (Detailed List) */}
                    <Panel title="Work Done History (Assigned/Done)">
                        {mentorTasks.length === 0 ? (
                            <p className="text-gray-500">No work records found for this mentor.</p>
                        ) : (
                            <div className="space-y-4">
                                <div className="flex justify-between font-bold text-indigo-800 border-b pb-2 mb-2">
                                    <span className="w-1/6">Date</span>
                                    <span className="w-2/6">Description (Chapter/Units)</span>
                                    <span className="w-1/6">Type</span>
                                    <span className="w-1/6 text-right">Minutes/Units</span>
                                    <span className="w-1/6 text-right">Rating</span>
                                </div>
                                <div className="max-h-96 overflow-y-auto">
                                    {mentorTasks.map((task) => (
                                        <div key={task.id} className="flex justify-between text-sm py-2 border-b last:border-b-0 hover:bg-gray-50">
                                            <span className="w-1/6 text-gray-600">{task.date?.toLocaleDateString()}</span>
                                            <span className="w-2/6 font-medium">
                                                {task.description}
                                                {task.chapterName && <span className="text-xs text-gray-500 block">({task.chapterName})</span>}
                                            </span>
                                            <span className="w-1/6">{task.taskType}</span>
                                            <span className="w-1/6 text-right font-mono">
                                                {task.taskType === 'Lecture' ? `${task.minutes} min` : `${task.chaptersCompleted} units`}
                                            </span>
                                            <span className="w-1/6 text-right font-mono text-indigo-600">{task.rating?.toFixed(1) || '-'}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}
                    </Panel>

                    {/* Weekly Payment Breakdowns (optional, showing how P_final sums up for the 90 days) */}
                    {Object.keys(tasksByWeek).length > 0 && (
                        <Panel title="Weekly Task Breakdown (Last 90 Days)">
                            <div className="space-y-4">
                                {Object.keys(tasksByWeek).sort().reverse().map(weekStart => {
                                    const weeklyTasks = tasksByWeek[weekStart];
                                    const weeklySummary = calculatePayment(weeklyTasks, mentor.baseRate);
                                    return (
                                        <div key={weekStart} className="bg-gray-50 p-4 rounded-lg border-l-4 border-indigo-500 shadow-sm">
                                            <div className="flex justify-between items-center mb-2">
                                                <h5 className="font-bold text-indigo-800">Week Starting: {new Date(weekStart).toLocaleDateString()}</h5>
                                                <span className="text-xl font-extrabold text-green-700">Rs {weeklySummary.P_final.toLocaleString()}</span>
                                            </div>
                                            <p className="text-sm text-gray-600 mb-2">
                                                Lecture Pay: Rs {weeklySummary.P_final_lectures.toLocaleString()} | Other Pay: Rs {weeklySummary.P_final_other.toLocaleString()}
                                            </p>
                                            <ul className="text-xs list-disc pl-5 space-y-1">
                                                {weeklyTasks.map(task => (
                                                    <li key={task.id}>
                                                        {task.date?.toLocaleDateString()}: {task.description} ({task.taskType}) - 
                                                        {task.taskType === 'Lecture' ? `${task.minutes} min` : `${task.chaptersCompleted} units`}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    );
                                })}
                            </div>
                        </Panel>
                    )}
                </div>
            </div>
        );
    };

    // E. Dashboard View
    const Dashboard = () => (
        <div className="p-6">
            <h1 className="text-3xl font-extrabold text-indigo-800 mb-6">PREP4IISER Management Dashboard</h1>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6 mb-8">
                <Panel title="Total Mentors" className="bg-indigo-50">
                    <p className="text-5xl font-extrabold text-indigo-600">{dashboardSummary.totalMentors}</p>
                </Panel>
                <Panel title="Total Tasks Logged" className="bg-green-50">
                    <p className="text-5xl font-extrabold text-green-600">{dashboardSummary.totalTasks}</p>
                    <p className="text-sm text-gray-500 mt-1">{dashboardSummary.totalLectures} Lectures</p>
                </Panel>
                <Panel title="Total Chapters/Units" className="bg-yellow-50">
                    <p className="text-5xl font-extrabold text-yellow-600">{dashboardSummary.totalUnits}</p>
                    <p className="text-sm text-gray-500 mt-1">Completed (Non-Lecture)</p>
                </Panel>
                <Panel title="Total Est. Payout" className="bg-red-50">
                    <p className="text-5xl font-extrabold text-red-600">Rs {dashboardSummary.totalPayments.toLocaleString()}</p>
                </Panel>
            </div>

            <Panel title="Mentor Payment & Work Overview" className="mb-6">
                <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-gray-200">
                        <thead>
                            <tr className="bg-gray-50">
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-1/4">Mentor Name</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-1/4">Teams</th>
                                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Total Tasks</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Est. Payout (Overall)</th>
                                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                            </tr>
                        </thead>
                        <tbody className="bg-white divide-y divide-gray-200">
                            {mentors.map(mentor => {
                                const mentorTasks = tasks.filter(t => t.mentorId === mentor.id);
                                const totalTasks = mentorTasks.length;
                                const paymentEntry = dashboardSummary.mentorPayments.find(p => p.mentorName === mentor.name);
                                const chaptersCompleted = mentorTasks.filter(t => t.taskType !== 'Lecture').reduce((sum, t) => sum + (t.chaptersCompleted || 0), 0);
                                
                                return (
                                    <tr key={mentor.id} className="hover:bg-gray-50 transition duration-100">
                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                                            <div className="flex items-center">
                                                <img src={mentor.photoURL} alt="" className="h-8 w-8 rounded-full mr-3 object-cover"/>
                                                {mentor.name}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                            <div className="flex flex-wrap gap-1">
                                                {mentor.teams.slice(0, 3).map(team => (
                                                    <span key={team} className="bg-indigo-100 text-indigo-700 px-2 py-0.5 text-xs rounded-full">
                                                        {team.split(' ')[0]}
                                                    </span>
                                                ))}
                                                {mentor.teams.length > 3 && <span className="text-xs text-gray-500">...</span>}
                                            </div>
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                                            {totalTasks} tasks
                                            {chaptersCompleted > 0 && <span className="text-xs text-indigo-500 block">({chaptersCompleted} units)</span>}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-sm font-bold text-right text-green-700">
                                            Rs {paymentEntry ? paymentEntry.payment.toLocaleString() : '0'}
                                        </td>
                                        <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium space-x-2">
                                            <Button
                                                onClick={() => setSelectedMentor(mentor)}
                                                className="bg-indigo-500 hover:bg-indigo-600 px-3 py-1 text-xs"
                                            >
                                                View Profile
                                            </Button>
                                            <Button
                                                onClick={() => handleEditMentor(mentor)}
                                                className="bg-yellow-500 hover:bg-yellow-600 px-3 py-1 text-xs"
                                            >
                                                Edit
                                            </Button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </Panel>
            <p className="text-xs text-gray-500 mt-4">Note: Est. Payout is calculated based on Lecture tasks (using PDF formula) and other tasks (Rs {calculatePayment([], 10).CHAPTER_RATE} per unit).</p>
        </div>
    );

    // F. Mentors List View (Primary Tab)
    const MentorsList = () => (
        <div className="p-6">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-3xl font-extrabold text-indigo-800">Mentor Directory</h1>
                <div className="space-x-3">
                    <Button onClick={handleNewMentor} className="bg-green-600 hover:bg-green-700">
                        + Add New Mentor
                    </Button>
                </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-6">
                {mentors.map(mentor => {
                    const mentorTasks = tasks.filter(t => t.mentorId === mentor.id);
                    const totalTasks = mentorTasks.length;
                    const paymentEntry = dashboardSummary.mentorPayments.find(p => p.mentorName === mentor.name);
                    const chaptersCompleted = mentorTasks.filter(t => t.taskType !== 'Lecture').reduce((sum, t) => sum + (t.chaptersCompleted || 0), 0);
                    
                    return (
                        <div key={mentor.id} className="bg-white rounded-xl shadow-lg hover:shadow-xl transition duration-300 p-5 flex flex-col">
                            <div className="flex items-start mb-4">
                                <img
                                    src={mentor.photoURL}
                                    alt={`${mentor.name} Photo`}
                                    className="w-16 h-16 rounded-full object-cover ring-2 ring-indigo-300 flex-shrink-0"
                                />
                                <div className="ml-4">
                                    <h3 className="text-xl font-bold text-gray-900">{mentor.name}</h3>
                                    <p className="text-sm text-indigo-600">{mentor.email}</p>
                                    <p className="text-xs text-gray-500">Rate: Rs {mentor.baseRate}/min</p>
                                </div>
                            </div>

                            <div className="flex flex-wrap gap-1 mb-3">
                                {mentor.teams.slice(0, 3).map(team => (
                                    <span key={team} className="bg-indigo-100 text-indigo-700 px-2 py-0.5 text-xs rounded-full">
                                        {team}
                                    </span>
                                ))}
                                {mentor.teams.length > 3 && <span className="text-xs text-gray-500">...</span>}
                            </div>

                            <div className="mt-auto border-t pt-3 space-y-2">
                                <p className="text-sm font-medium text-gray-700">
                                    Work Done: <span className="font-bold text-indigo-700">{totalTasks}</span> tasks
                                    {chaptersCompleted > 0 && <span className="text-xs text-indigo-500 block">({chaptersCompleted} units)</span>}
                                </p>
                                <p className="text-sm font-medium text-gray-700">Est. Payout: <span className="font-bold text-green-700">Rs {paymentEntry ? paymentEntry.payment.toLocaleString() : '0'}</span></p>

                                <div className="flex space-x-2 mt-3">
                                    <Button
                                        onClick={() => setSelectedMentor(mentor)}
                                        className="bg-indigo-600 hover:bg-indigo-700 flex-grow text-xs"
                                    >
                                        View Profile
                                    </Button>
                                    <Button
                                        onClick={() => setShowMentorModal(true) & setCurrentMentorData(mentor)}
                                        className="bg-yellow-500 hover:bg-yellow-600 px-3 py-1 text-xs"
                                    >
                                        Edit
                                    </Button>
                                    <Button
                                        onClick={() => setTaskMentor(mentor)} // Correctly setting state here
                                        className="bg-blue-500 hover:bg-blue-600 px-3 py-1 text-xs"
                                        title="Submit Work"
                                    >
                                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
                                          <path d="M17.414 2.586a2 2 0 00-2.828 0L7 10.172V13h2.828l7.586-7.586a2 2 0 000-2.828z" />
                                          <path fillRule="evenodd" d="M2 6a2 2 0 012-2h4a1 1 0 010 2H4v10h10v-4a1 1 0 112 0v4a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" clipRule="evenodd" />
                                        </svg>
                                    </Button>
                                </div>
                            </div>
                        </div>
                    );
                })}
            </div>
        </div>
    );

    // G. Teams View (Primary Tab)
    const TeamsView = () => (
        <div className="p-6">
            <div className="flex justify-between items-center mb-6">
                <h1 className="text-3xl font-extrabold text-indigo-800">Team/Role Management</h1>
                <Button onClick={() => setShowTeamModal(true)} className="bg-green-600 hover:bg-green-700">
                    Manage Teams
                </Button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {teams.map(team => {
                    const members = mentors.filter(m => m.teams.includes(team));
                    return (
                        <Panel key={team} title={team} className="bg-indigo-50">
                            <p className="text-4xl font-extrabold text-indigo-600 mb-4">{members.length}</p>
                            <h4 className="font-semibold mb-2">Members:</h4>
                            <div className="space-y-2 max-h-48 overflow-y-auto">
                                {members.length > 0 ? members.map(member => (
                                    <div key={member.id} className="flex items-center space-x-3 p-2 bg-white rounded-lg shadow-sm">
                                        <img src={member.photoURL} alt="" className="h-6 w-6 rounded-full object-cover"/>
                                        <span className="text-sm font-medium">{member.name}</span>
                                    </div>
                                )) : (
                                    <p className="text-sm text-gray-500">No members assigned to this team.</p>
                                )}
                            </div>
                        </Panel>
                    );
                })}
            </div>
        </div>
    );

    // H. Tab Navigation
    const TabButton = ({ id, label }) => (
        <button
            onClick={() => { setActiveTab(id); setSelectedMentor(null); }}
            className={`py-3 px-6 text-sm font-semibold transition-colors duration-200 ${
                activeTab === id
                    ? 'border-b-4 border-indigo-600 text-indigo-800 bg-white'
                    : 'border-b-4 border-transparent text-gray-600 hover:text-indigo-600 hover:border-indigo-100'
            }`}
        >
            {label}
        </button>
    );

    // --- Main Render ---
    return (
        <div className="min-h-screen bg-gray-100 font-sans">
            <style jsx="true">{`
                /* Simple fade-in animation for modals */
                @keyframes fadeIn {
                    from { opacity: 0; transform: translateY(-10px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                .animate-fade-in {
                    animation: fadeIn 0.2s ease-out;
                }
                /* Print styles */
                @media print {
                    body > * { display: none !important; }
                    .print-friendly { display: block !important; }
                    .print-friendly * { visibility: visible !important; }
                    .print-friendly { position: absolute; left: 0; top: 0; width: 100%; }
                    .no-print { display: none !important; }
                    .page-break { page-break-after: always; }
                    .flex, .grid { display: block; }
                    .w-1/6, .w-2/6, .w-full { width: 100%; }
                }
            `}</style>
            {/* Header/Navigation */}
            <header className="bg-white shadow-md sticky top-0 z-40">
                <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div className="flex justify-between items-center h-16">
                        <h1 className="text-2xl font-black text-indigo-800 tracking-wider">
                            PREP4IISER <span className="text-sm font-medium text-gray-500">/ Management Portal</span>
                        </h1>
                        <div className="text-xs text-gray-500">
                            Logged in as: <span className="font-mono bg-gray-100 p-1 rounded-sm">{userId?.substring(0, 8)}...</span>
                        </div>
                    </div>
                    <nav className="flex space-x-1">
                        <TabButton id="dashboard" label="Dashboard" />
                        <TabButton id="mentors" label="Mentor Management" />
                        <TabButton id="teams" label="Teams/Roles" />
                        <TabButton id="tasks" label="Task Submission" />
                    </nav>
                </div>
            </header>

            <main className="max-w-7xl mx-auto">
                {selectedMentor ? (
                    <MentorProfile mentor={selectedMentor} onBack={() => setSelectedMentor(null)} />
                ) : (
                    <>
                        {activeTab === 'dashboard' && <Dashboard />}
                        {activeTab === 'mentors' && <MentorsList />}
                        {activeTab === 'teams' && <TeamsView />}
                        {activeTab === 'tasks' && <MentorsList />} {/* Reuse MentorsList for task submission selection */}
                    </>
                )}
            </main>

            {/* Modals */}
            {showMentorModal && (
                <MentorModal mentor={currentMentorData} onClose={() => setShowMentorModal(false)} />
            )}
            {showTeamModal && (
                <TeamsModal onClose={() => setShowTeamModal(false)} />
            )}
            {/* Conditional rendering of TaskModal now uses the top-level taskMentor state */}
            {taskMentor && (
                <TaskModal mentor={taskMentor} onClose={() => setTaskMentor(null)} />
            )}

        </div>
    );
};

export default App;