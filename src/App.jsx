import { useEffect, useMemo, useRef, useState } from "react";
import {
    MapContainer,
    TileLayer,
    Marker,
    Popup,
    useMapEvents,
} from "react-leaflet";
import "leaflet/dist/leaflet.css";
import L from "leaflet";

import markerIcon2x from "leaflet/dist/images/marker-icon-2x.png";
import markerIcon from "leaflet/dist/images/marker-icon.png";
import markerShadow from "leaflet/dist/images/marker-shadow.png";

import { supabase } from "./supabaseClient";

// Fix default Leaflet marker paths
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: markerIcon2x,
    iconUrl: markerIcon,
    shadowUrl: markerShadow,
});

// Shared spot-type configuration (used by filters + form)
const SPOT_TYPE_OPTIONS = [
    {
        value: "forest_road",
        label: "Free camping / public land",
    },
    {
        value: "campground",
        label: "Campground / RV park",
    },
    {
        value: "walmart",
        label: "Store / plaza parking",
    },
    {
        value: "rest_area",
        label: "Highway rest area",
    },
    {
        value: "city_stealth",
        label: "City street / stealth",
    },
    {
        value: "truck_stop",
        label: "Truck stop / travel plaza",
    },
    {
        value: "scenic_view",
        label: "Scenic viewpoint / overlook",
    },
    {
        value: "water_source",
        label: "Water fill / spigot",
    },
    {
        value: "shower",
        label: "Showers / gym / truck stop",
    },
    {
        value: "laundromat",
        label: "Laundry / laundromat",
    },
    {
        value: "other",
        label: "Other / something else",
    },
];

function AddSpotOnClick({ active, onMapClick }) {
    useMapEvents({
        click(e) {
            if (!active) return;
            onMapClick(e.latlng.lat, e.latlng.lng);
        },
    });
    return null;
}

function clamp(num, min, max) {
    if (Number.isNaN(num)) return min;
    return Math.min(Math.max(num, min), max);
}

// Haversine distance in km (for "Spots nearby")
function haversineDistanceKm(a, b) {
    if (!a || !b) return null;
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;

    const sinDLat = Math.sin(dLat / 2);
    const sinDLng = Math.sin(dLng / 2);

    const h =
        sinDLat * sinDLat +
        Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;

    const c = 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
    return R * c;
}

// Map from spot_type -> emoji/icon
function getSpotTypeIcon(type) {
    const t = (type || "other").toLowerCase();
    if (t === "forest_road") return "🌲";
    if (t === "walmart") return "🛒";
    if (t === "rest_area") return "🛣️";
    if (t === "city_stealth") return "🏙️";
    if (t === "campground") return "🏕️";
    if (t === "scenic_view") return "🌄";
    if (t === "truck_stop") return "⛽";
    if (t === "water_source") return "🚰";
    if (t === "shower") return "🚿";
    if (t === "laundromat") return "🧺";
    return "📍";
}

function formatNoiseLevel(noise) {
    const t = (noise || "unknown").toLowerCase();
    switch (t) {
        case "silent":
            return "Silent";
        case "very_quiet":
            return "Very quiet";
        case "quiet":
            return "Quiet";
        case "some_road":
        case "some_road_noise":
            return "Some road noise";
        case "steady_noise":
            return "Loud but steady";
        case "party":
            return "Party / unpredictable";
        case "medium": // legacy
            return "Medium";
        case "noisy": // legacy
            return "Noisy";
        default:
            return "Unknown";
    }
}

const initialSpotForm = {
    name: "",
    description: "",
    overnightAllowed: false,
    hasBathroom: false,
    cellSignal: 3,
    noiseLevel: "quiet",
    safetyRating: 4,
    spotType: "forest_road",
    photoUrls: "",
};

const initialReviewForm = {
    rating: 5,
    comment: "",
    nickname: "",
};

function App() {
    const [spots, setSpots] = useState([]);
    const [reviews, setReviews] = useState([]);
    const [adding, setAdding] = useState(false); // using sheet for add/edit
    const [editMode, setEditMode] = useState(false);
    const [editingSpotId, setEditingSpotId] = useState(null);
    const [pendingLocation, setPendingLocation] = useState(null);
    const [spotForm, setSpotForm] = useState(initialSpotForm);
    const [reviewForm, setReviewForm] = useState(initialReviewForm);
    const [selectedSpotId, setSelectedSpotId] = useState(null);
    const [loading, setLoading] = useState(true);
    const [savingSpot, setSavingSpot] = useState(false);
    const [savingReview, setSavingReview] = useState(false);
    const [status, setStatus] = useState("Connecting to Supabase…");
    const [errorMsg, setErrorMsg] = useState("");
    const [reviewError, setReviewError] = useState("");
    const [darkMode, setDarkMode] = useState(true);
    const [activePhoto, setActivePhoto] = useState(null);
    const [userLocation, setUserLocation] = useState(null);

    // map style: "standard" | "satellite"
    const [mapStyle, setMapStyle] = useState("standard");

    // Filters
    const [filterOvernightOnly, setFilterOvernightOnly] = useState(false);
    const [filterFavoritesOnly, setFilterFavoritesOnly] = useState(false);
    // multi-select type filters
    const [activeTypes, setActiveTypes] = useState([]); // array of spot_type values

    // Auth
    const [currentUser, setCurrentUser] = useState(null);
    const [authBusy, setAuthBusy] = useState(false);

    // Local favorites (starred spots)
    const [favoriteIds, setFavoriteIds] = useState(() => {
        if (typeof window === "undefined") return new Set();
        try {
            const raw = window.localStorage.getItem(
                "nomad_safe_spots_favorites"
            );
            return raw ? new Set(JSON.parse(raw)) : new Set();
        } catch {
            return new Set();
        }
    });

    // Photo upload state
    const [spotPhotoFiles, setSpotPhotoFiles] = useState([]);
    const [uploadingPhotos, setUploadingPhotos] = useState(false);
    const fileInputRef = useRef(null);

    useEffect(() => {
        try {
            window.localStorage.setItem(
                "nomad_safe_spots_favorites",
                JSON.stringify(Array.from(favoriteIds))
            );
        } catch {
            // ignore
        }
    }, [favoriteIds]);

    const toggleFavorite = (spotId) => {
        setFavoriteIds((prev) => {
            const next = new Set(prev);
            if (next.has(spotId)) {
                next.delete(spotId);
            } else {
                next.add(spotId);
            }
            return next;
        });
    };

    const isFavorite = (spotId) => favoriteIds.has(spotId);

    const mapRef = useRef(null);
    const center = [39.5, -98.35]; // Center of US

    // Load spots + reviews
    useEffect(() => {
        async function loadData() {
            setStatus("Loading spots and reviews from Supabase…");

            const [spotsRes, reviewsRes] = await Promise.all([
                supabase
                    .from("spots")
                    .select("*")
                    .order("id", { ascending: true }),
                supabase
                    .from("reviews")
                    .select("*")
                    .order("created_at", { ascending: false }),
            ]);

            if (spotsRes.error) {
                console.error("Error loading spots:", spotsRes.error);
                setStatus("Error loading spots: " + spotsRes.error.message);
                alert("Error loading spots: " + spotsRes.error.message);
            } else {
                setSpots(spotsRes.data || []);
                setStatus(
                    `Connected. Spots: ${spotsRes.data?.length || 0
                    }, Reviews: ${reviewsRes.data?.length || 0}`
                );
            }

            if (reviewsRes.error) {
                console.error("Error loading reviews:", reviewsRes.error);
            } else {
                setReviews(reviewsRes.data || []);
            }

            setLoading(false);
        }

        loadData();
    }, []);

    // Auth: get current user and subscribe to changes
    useEffect(() => {
        let subscription;

        (async () => {
            const { data, error } = await supabase.auth.getUser();
            if (!error && data?.user) {
                setCurrentUser(data.user);
            }

            const { data: listener } = supabase.auth.onAuthStateChange(
                (_event, session) => {
                    setCurrentUser(session?.user ?? null);
                }
            );

            subscription = listener?.subscription;
        })();

        return () => {
            if (subscription) subscription.unsubscribe();
        };
    }, []);

    const selectedSpot = useMemo(
        () => spots.find((s) => s.id === selectedSpotId) || null,
        [spots, selectedSpotId]
    );

    const selectedSpotReviews = useMemo(
        () =>
            selectedSpotId
                ? reviews.filter((r) => r.spot_id === selectedSpotId)
                : [],
        [reviews, selectedSpotId]
    );

    const selectedSpotAverageRating = useMemo(() => {
        if (!selectedSpotReviews.length) return null;
        const sum = selectedSpotReviews.reduce(
            (acc, r) => acc + (r.rating || 0),
            0
        );
        return sum / selectedSpotReviews.length;
    }, [selectedSpotReviews]);

    const filteredSpots = useMemo(() => {
        let list = spots;

        if (activeTypes.length > 0) {
            const typeSet = new Set(
                activeTypes.map((t) => t.toLowerCase())
            );
            list = list.filter((s) =>
                typeSet.has((s.spot_type || "other").toLowerCase())
            );
        }

        if (filterOvernightOnly) {
            list = list.filter((s) => !!s.overnight_allowed);
        }

        if (filterFavoritesOnly) {
            list = list.filter((s) => favoriteIds.has(s.id));
        }

        return list;
    }, [
        spots,
        activeTypes,
        filterOvernightOnly,
        filterFavoritesOnly,
        favoriteIds,
    ]);

    // For the side "Spots nearby" list
    const spotsForList = useMemo(() => {
        return filteredSpots
            .map((spot) => {
                const spotReviews = reviews.filter(
                    (r) => r.spot_id === spot.id
                );
                const reviewCount = spotReviews.length;
                const avgRating =
                    reviewCount > 0
                        ? spotReviews.reduce(
                            (sum, r) => sum + (r.rating || 0),
                            0
                        ) / reviewCount
                        : null;

                const distanceKm = userLocation
                    ? haversineDistanceKm(
                        {
                            lat: userLocation.lat,
                            lng: userLocation.lng,
                        },
                        { lat: spot.lat, lng: spot.lng }
                    )
                    : null;

                return { ...spot, avgRating, reviewCount, distanceKm };
            })
            .sort((a, b) => {
                const aFav = favoriteIds.has(a.id);
                const bFav = favoriteIds.has(b.id);
                if (aFav !== bFav) return aFav ? -1 : 1;

                if (a.distanceKm != null && b.distanceKm != null) {
                    if (a.distanceKm !== b.distanceKm) {
                        return a.distanceKm - b.distanceKm;
                    }
                }

                if (a.avgRating != null && b.avgRating != null) {
                    if (b.avgRating !== a.avgRating) {
                        return b.avgRating - a.avgRating;
                    }
                }

                return (a.name || "").localeCompare(b.name || "");
            });
    }, [filteredSpots, userLocation, favoriteIds, reviews]);

    // Add / edit flow

    function startAdding() {
        setAdding(true);
        setEditMode(false);
        setEditingSpotId(null);
        setPendingLocation(null);
        setSpotForm(initialSpotForm);
        setSpotPhotoFiles([]);
        setErrorMsg("");
    }

    function startEditingSpot(spot) {
        if (!spot) return;
        setAdding(true);
        setEditMode(true);
        setEditingSpotId(spot.id);
        setPendingLocation({ lat: spot.lat, lng: spot.lng });
        setSpotForm({
            name: spot.name || "",
            description: spot.description || "",
            overnightAllowed: !!spot.overnight_allowed,
            hasBathroom: !!spot.has_bathroom,
            cellSignal: spot.cell_signal ?? 3,
            noiseLevel: spot.noise_level || "quiet",
            safetyRating: spot.safety_rating ?? 4,
            spotType: spot.spot_type || "forest_road",
            photoUrls: (spot.photo_urls || []).join(", "),
        });
        setSpotPhotoFiles([]);
        setErrorMsg("");
    }

    function cancelAdding() {
        setAdding(false);
        setEditMode(false);
        setEditingSpotId(null);
        setPendingLocation(null);
        setSpotForm(initialSpotForm);
        setSpotPhotoFiles([]);
        setErrorMsg("");
    }

    function handleMapClick(lat, lng) {
        if (!adding) return;
        setPendingLocation({ lat, lng });
        setErrorMsg("");
    }

    function handleSpotInputChange(e) {
        const { name, value } = e.target;
        setSpotForm((prev) => ({
            ...prev,
            [name]: value,
        }));
    }

    function handleReviewInputChange(e) {
        const { name, value } = e.target;
        setReviewForm((prev) => ({
            ...prev,
            [name]: value,
        }));
    }

    function handlePhotoFileChange(e) {
        const files = Array.from(e.target.files || []).slice(0, 4);
        setSpotPhotoFiles(files);
    }

    async function handleSaveSpot(e) {
        e.preventDefault();
        setErrorMsg("");

        if (!pendingLocation) {
            setErrorMsg("Tap on the map to choose a location.");
            return;
        }

        if (!spotForm.name.trim()) {
            setErrorMsg("Name is required.");
            return;
        }

        // If user selected photos but isn't logged in, bail early with a clear message
        if (spotPhotoFiles.length > 0 && !currentUser) {
            setErrorMsg(
                "To upload photos, please sign in first. You can still save the spot without photos."
            );
            return;
        }

        const { lat, lng } = pendingLocation;
        const cell_signal = clamp(
            parseInt(spotForm.cellSignal, 10) || 0,
            0,
            5
        );
        const safety_rating = clamp(
            parseInt(spotForm.safetyRating, 10) || 0,
            0,
            5
        );
        const noise_level = spotForm.noiseLevel || "unknown";
        const spot_type = spotForm.spotType || "other";

        // Parse manual URLs
        let manualUrls = [];
        if (spotForm.photoUrls.trim()) {
            manualUrls = spotForm.photoUrls
                .split(",")
                .map((u) => u.trim())
                .filter(Boolean);
        }

        setSavingSpot(true);

        // Upload any new photos to Supabase storage
        let uploadedUrls = [];
        if (spotPhotoFiles.length > 0) {
            setUploadingPhotos(true);
            try {
                for (const file of spotPhotoFiles) {
                    const ext =
                        file.name.split(".").pop()?.toLowerCase() || "jpg";
                    const path = `${currentUser?.id || "anon"
                        }/${Date.now()}-${Math.random()
                            .toString(36)
                            .slice(2)}.${ext}`;

                    const { error: uploadError } = await supabase.storage
                        .from("spot-photos")
                        .upload(path, file, {
                            cacheControl: "3600",
                            upsert: false,
                        });

                    if (uploadError) {
                        console.error("Upload error:", uploadError);
                        throw uploadError;
                    }

                    const { data: publicData } = supabase.storage
                        .from("spot-photos")
                        .getPublicUrl(path);

                    if (publicData?.publicUrl) {
                        uploadedUrls.push(publicData.publicUrl);
                    }
                }
            } catch (err) {
                console.error("Error uploading photos:", err);
                setSavingSpot(false);
                setUploadingPhotos(false);
                setErrorMsg(
                    "Failed to upload photos. You can try again or save without photos."
                );
                return;
            } finally {
                setUploadingPhotos(false);
            }
        }

        const combinedPhotoUrls = [...manualUrls, ...uploadedUrls];

        const payload = {
            name: spotForm.name.trim(),
            description: spotForm.description.trim(),
            lat,
            lng,
            overnight_allowed: spotForm.overnightAllowed,
            has_bathroom: spotForm.hasBathroom,
            cell_signal,
            noise_level,
            safety_rating,
            spot_type,
            photo_urls: combinedPhotoUrls, // empty array if none
        };

        try {
            if (editMode && editingSpotId != null) {
                // UPDATE existing spot (no .single() to avoid "Cannot coerce..." errors)
                const { error } = await supabase
                    .from("spots")
                    .update(payload)
                    .eq("id", editingSpotId);

                if (error) {
                    console.error("Error updating spot:", error);
                    setErrorMsg("Failed to save spot: " + error.message);
                } else {
                    // update local state manually
                    setSpots((prev) =>
                        prev.map((s) =>
                            s.id === editingSpotId ? { ...s, ...payload } : s
                        )
                    );
                    setSelectedSpotId(editingSpotId);
                    cancelAdding();
                }
            } else {
                // INSERT new spot
                const { data, error } = await supabase
                    .from("spots")
                    .insert(payload)
                    .select()
                    .single();

                if (error) {
                    console.error("Error saving spot:", error);
                    setErrorMsg("Failed to save spot: " + error.message);
                } else if (data) {
                    setSpots((prev) => [...prev, data]);
                    setSelectedSpotId(data.id);
                    cancelAdding();
                }
            }
        } finally {
            setSavingSpot(false);
            setSpotPhotoFiles([]);
            if (fileInputRef.current) {
                fileInputRef.current.value = "";
            }
        }
    }

    async function handleAddReview(e) {
        e.preventDefault();
        setReviewError("");

        if (!selectedSpot) {
            setReviewError("Select a spot first.");
            return;
        }

        const rating = clamp(parseInt(reviewForm.rating, 10) || 0, 1, 5);
        if (!rating) {
            setReviewError("Rating 1–5 is required.");
            return;
        }

        if (!reviewForm.comment.trim()) {
            setReviewError("Please add a short comment.");
            return;
        }

        setSavingReview(true);

        const { data, error } = await supabase
            .from("reviews")
            .insert({
                spot_id: selectedSpot.id,
                rating,
                comment: reviewForm.comment.trim(),
                nickname: reviewForm.nickname.trim() || null,
            })
            .select()
            .single();

        setSavingReview(false);

        if (error) {
            console.error("Error saving review:", error);
            setReviewError("Failed to save review: " + error.message);
            return;
        }

        setReviews((prev) => [data, ...prev]);
        setReviewForm(initialReviewForm);
    }

    function handleLocateMe() {
        if (!navigator.geolocation) {
            setStatus("Geolocation is not supported in this browser.");
            return;
        }

        setStatus("Finding your location…");

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                const loc = { lat: latitude, lng: longitude };
                setUserLocation(loc);
                if (mapRef.current) {
                    mapRef.current.setView([latitude, longitude], 9);
                }
                setStatus((prev) =>
                    prev.startsWith("Finding") ? "Location updated." : prev
                );
            },
            (err) => {
                console.error("Geolocation error:", err);
                setStatus("Could not get location: " + err.message);
            }
        );
    }

    function openSpotInMaps(spot) {
        if (!spot) return;
        const url = `https://www.google.com/maps?q=${spot.lat},${spot.lng}`;
        window.open(url, "_blank");
    }

    async function handleSignIn() {
        if (authBusy) return;
        const email = window.prompt(
            "Enter your email address to receive a login link:"
        );
        if (!email) return;

        setAuthBusy(true);
        const { error } = await supabase.auth.signInWithOtp({
            email,
            options: {
                emailRedirectTo: window.location.origin,
            },
        });
        setAuthBusy(false);

        if (error) {
            console.error("Auth error:", error);
            alert("Login failed: " + error.message);
        } else {
            alert("Check your email for the login link.");
        }
    }

    async function handleSignOut() {
        if (authBusy) return;
        setAuthBusy(true);
        await supabase.auth.signOut();
        setAuthBusy(false);
    }

    const appClassName = darkMode ? "app glass dark" : "app glass";

    // tile layer config based on mapStyle
    const tileLayerConfig =
        mapStyle === "satellite"
            ? {
                url: "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
                attribution:
                    "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community",
            }
            : {
                url: "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
                attribution: "&copy; OpenStreetMap contributors",
            };

    return (
        <div className={appClassName}>
            <header className="app-header">
                <div className="brand-row">
                    <div className="brand-main">
                        <h1>Nomad Safe Spots</h1>
                        <p className="subtitle">
                            A free and easy to use map of safe parking &amp; rest
                            spots – community powered.
                        </p>
                        <p className="brand-by">
                            Crafted by{" "}
                            <span className="brand-name">Statusnone</span>
                        </p>
                    </div>
                    <div className="header-controls">
                        <button
                            type="button"
                            className="btn-ghost"
                            onClick={handleLocateMe}
                        >
                            📍 My location
                        </button>
                        <button
                            type="button"
                            className="btn-ghost"
                            onClick={() =>
                                setMapStyle((prev) =>
                                    prev === "standard" ? "satellite" : "standard"
                                )
                            }
                        >
                            {mapStyle === "standard"
                                ? "🛰 Satellite"
                                : "🗺 Map view"}
                        </button>
                        <button
                            type="button"
                            className="btn-ghost"
                            onClick={() => setDarkMode((d) => !d)}
                        >
                            {darkMode ? "☀️ Light" : "🌙 Dark"}
                        </button>
                        <button
                            type="button"
                            className="btn-ghost"
                            onClick={currentUser ? handleSignOut : handleSignIn}
                        >
                            {currentUser
                                ? currentUser.email || "Signed in"
                                : authBusy
                                    ? "Sending link…"
                                    : "Sign in"}
                        </button>
                    </div>
                </div>

                <p className="status-text">{status}</p>

                <div className="header-actions">
                    <button className="btn-primary" onClick={startAdding}>
                        ➕ Add Spot
                    </button>
                </div>

                {/* Filters */}
                <div className="filters-row">
                    <div className="filters-group">
                        <label className="filters-label">Types</label>
                        <div className="filters-chips">
                            <button
                                type="button"
                                className={`filter-chip ${activeTypes.length === 0
                                        ? "filter-chip--active"
                                        : ""
                                    }`}
                                onClick={() => setActiveTypes([])}
                            >
                                All
                            </button>
                            {SPOT_TYPE_OPTIONS.map((opt) => (
                                <button
                                    key={opt.value}
                                    type="button"
                                    className={`filter-chip ${activeTypes.includes(opt.value)
                                            ? "filter-chip--active"
                                            : ""
                                        }`}
                                    onClick={() =>
                                        setActiveTypes((prev) =>
                                            prev.includes(opt.value)
                                                ? prev.filter(
                                                    (v) => v !== opt.value
                                                )
                                                : [...prev, opt.value]
                                        )
                                    }
                                >
                                    {getSpotTypeIcon(opt.value)} {opt.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="filters-right">
                        <label className="filters-toggle">
                            <input
                                type="checkbox"
                                checked={filterOvernightOnly}
                                onChange={(e) =>
                                    setFilterOvernightOnly(e.target.checked)
                                }
                            />
                            <span>Overnight only</span>
                        </label>

                        <button
                            type="button"
                            className={`filter-chip ${filterFavoritesOnly
                                    ? "filter-chip--active"
                                    : ""
                                }`}
                            onClick={() =>
                                setFilterFavoritesOnly((prev) => !prev)
                            }
                        >
                            ⭐ Favorites
                        </button>
                    </div>
                </div>

                {loading && <p className="small-text">Loading spots…</p>}
            </header>

            <div className="main-content">
                <div className="map-shell">
                    <div className="map-wrapper">
                        <MapContainer
                            center={center}
                            zoom={4}
                            scrollWheelZoom
                            className="map"
                            ref={mapRef}
                        >
                            <TileLayer
                                attribution={tileLayerConfig.attribution}
                                url={tileLayerConfig.url}
                            />

                            <AddSpotOnClick
                                active={adding}
                                onMapClick={handleMapClick}
                            />

                            {filteredSpots.map((spot) => (
                                <Marker
                                    key={spot.id}
                                    position={[spot.lat, spot.lng]}
                                    eventHandlers={{
                                        click: () => setSelectedSpotId(spot.id),
                                    }}
                                >
                                    <Popup>
                                        <strong>
                                            {getSpotTypeIcon(spot.spot_type)}{" "}
                                            {spot.name}
                                        </strong>
                                        <br />
                                        {spot.description}
                                        <br />
                                        <small>
                                            Lat: {spot.lat.toFixed(4)}, Lng:{" "}
                                            {spot.lng.toFixed(4)}
                                        </small>
                                        <br />
                                        <br />
                                        <div className="popup-meta">
                                            <div>
                                                Type:{" "}
                                                {(spot.spot_type || "other")
                                                    .replace("_", " ")
                                                    .replace(/\b\w/g, (c) =>
                                                        c.toUpperCase()
                                                    )}
                                            </div>
                                            <div>
                                                Overnight allowed:{" "}
                                                {spot.overnight_allowed
                                                    ? "Yes"
                                                    : "No / unknown"}
                                            </div>
                                            <div>
                                                Bathrooms:{" "}
                                                {spot.has_bathroom
                                                    ? "Yes"
                                                    : "No / nearby / ?"}
                                            </div>
                                            <div>
                                                Cell:{" "}
                                                {spot.cell_signal ?? 0} / 5 bars
                                            </div>
                                            <div>
                                                Noise:{" "}
                                                {formatNoiseLevel(
                                                    spot.noise_level
                                                )}
                                            </div>
                                            <div>
                                                Safety:{" "}
                                                {spot.safety_rating ?? 0} / 5
                                            </div>
                                        </div>
                                    </Popup>
                                </Marker>
                            ))}

                            {adding && pendingLocation && (
                                <Marker
                                    position={[
                                        pendingLocation.lat,
                                        pendingLocation.lng,
                                    ]}
                                >
                                    <Popup>
                                        {editMode
                                            ? "Edit spot location (not saved yet)"
                                            : "New spot location (not saved yet)"}
                                    </Popup>
                                </Marker>
                            )}

                            {userLocation && (
                                <Marker
                                    position={[
                                        userLocation.lat,
                                        userLocation.lng,
                                    ]}
                                >
                                    <Popup>You are here</Popup>
                                </Marker>
                            )}
                        </MapContainer>
                    </div>
                </div>

                {/* Right-hand column: list + details/reviews */}
                <div className="side-column">
                    {/* Spot list panel */}
                    <aside className="spot-list-panel">
                        <div className="spot-list-header">
                            <h3 className="spot-list-title">Spots nearby</h3>
                            <span className="spot-list-count">
                                {spotsForList.length} result
                                {spotsForList.length === 1 ? "" : "s"}
                            </span>
                        </div>

                        <div className="spot-list-body">
                            {spotsForList.map((spot) => {
                                const typeLabel = (spot.spot_type || "other")
                                    .replace("_", " ")
                                    .replace(/\b\w/g, (c) => c.toUpperCase());

                                return (
                                    <button
                                        key={spot.id}
                                        className={`spot-list-item ${selectedSpotId === spot.id
                                                ? "spot-list-item--active"
                                                : ""
                                            }`}
                                        onClick={() => {
                                            setSelectedSpotId(spot.id);
                                            if (mapRef.current) {
                                                mapRef.current.setView(
                                                    [spot.lat, spot.lng],
                                                    14
                                                );
                                            }
                                        }}
                                    >
                                        <div className="spot-list-item-main">
                                            <div className="spot-list-item-title-row">
                                                <span className="spot-list-item-name">
                                                    {spot.name}
                                                </span>
                                                {favoriteIds.has(spot.id) && (
                                                    <span className="spot-list-item-fav">
                                                        ⭐
                                                    </span>
                                                )}
                                            </div>
                                            <div className="spot-list-item-meta">
                                                <span className="spot-list-item-type">
                                                    {typeLabel}
                                                </span>
                                                {spot.avgRating != null && (
                                                    <span className="spot-list-item-rating">
                                                        ★{" "}
                                                        {spot.avgRating.toFixed(
                                                            1
                                                        )}{" "}
                                                        <span className="spot-list-item-rating-count">
                                                            (
                                                            {
                                                                spot.reviewCount
                                                            }
                                                            )
                                                        </span>
                                                    </span>
                                                )}
                                            </div>
                                        </div>
                                        <div className="spot-list-item-distance">
                                            {spot.distanceKm != null ? (
                                                <span>
                                                    {spot.distanceKm < 1
                                                        ? `${Math.round(
                                                            spot.distanceKm *
                                                            1000
                                                        )} m`
                                                        : `${spot.distanceKm.toFixed(
                                                            1
                                                        )} km`}
                                                </span>
                                            ) : (
                                                <span className="spot-list-item-distance--muted">
                                                    distance…
                                                </span>
                                            )}
                                        </div>
                                    </button>
                                );
                            })}

                            {spotsForList.length === 0 && (
                                <div className="spot-list-empty">
                                    No spots match the filters yet.
                                </div>
                            )}
                        </div>
                    </aside>

                    {/* Bottom sheet / sidebar */}
                    <aside className="sheet">
                        {/* Add / Edit Spot */}
                        {adding && (
                            <div className="sheet-section">
                                <h2 className="sheet-title">
                                    {editMode ? "Edit Spot" : "Add a New Spot"}
                                </h2>

                                {!pendingLocation && (
                                    <p className="small-text highlight">
                                        Step 1: Tap on the map to pick a location.
                                    </p>
                                )}

                                {pendingLocation && (
                                    <p className="small-text">
                                        Location selected:
                                        <br />
                                        Lat: {pendingLocation.lat.toFixed(4)}, Lng:{" "}
                                        {pendingLocation.lng.toFixed(4)}
                                    </p>
                                )}

                                {pendingLocation && (
                                    <form
                                        className="spot-form"
                                        onSubmit={handleSaveSpot}
                                    >
                                        <div className="form-group">
                                            <label>Name *</label>
                                            <input
                                                type="text"
                                                name="name"
                                                value={spotForm.name}
                                                onChange={handleSpotInputChange}
                                                placeholder="E.g. Quiet forest pull-off"
                                                required
                                            />
                                        </div>

                                        <div className="form-group">
                                            <label>Description</label>
                                            <textarea
                                                name="description"
                                                value={spotForm.description}
                                                onChange={handleSpotInputChange}
                                                placeholder="What should people know about this spot?"
                                                rows={3}
                                            />
                                        </div>

                                        <div className="form-group">
                                            <label>Spot type</label>
                                            <select
                                                name="spotType"
                                                value={spotForm.spotType}
                                                onChange={handleSpotInputChange}
                                            >
                                                {SPOT_TYPE_OPTIONS.map(
                                                    (opt) => (
                                                        <option
                                                            key={opt.value}
                                                            value={opt.value}
                                                        >
                                                            {opt.label}
                                                        </option>
                                                    )
                                                )}
                                            </select>
                                        </div>

                                        <div className="form-row">
                                            <label>
                                                <input
                                                    type="checkbox"
                                                    checked={
                                                        spotForm.overnightAllowed
                                                    }
                                                    onChange={(e) =>
                                                        setSpotForm((prev) => ({
                                                            ...prev,
                                                            overnightAllowed:
                                                                e.target
                                                                    .checked,
                                                        }))
                                                    }
                                                />{" "}
                                                Overnight allowed
                                            </label>
                                        </div>

                                        <div className="form-row">
                                            <label>
                                                <input
                                                    type="checkbox"
                                                    checked={spotForm.hasBathroom}
                                                    onChange={(e) =>
                                                        setSpotForm((prev) => ({
                                                            ...prev,
                                                            hasBathroom:
                                                                e.target
                                                                    .checked,
                                                        }))
                                                    }
                                                />{" "}
                                                Bathrooms available
                                            </label>
                                        </div>

                                        <div className="form-group inline">
                                            <div>
                                                <label>Cell signal</label>
                                                <select
                                                    name="cellSignal"
                                                    value={spotForm.cellSignal}
                                                    onChange={
                                                        handleSpotInputChange
                                                    }
                                                >
                                                    <option value="0">
                                                        0 – no service at all
                                                    </option>
                                                    <option value="1">
                                                        1 – one bar / mostly
                                                        useless
                                                    </option>
                                                    <option value="2">
                                                        2 – spotty but can text
                                                    </option>
                                                    <option value="3">
                                                        3 – decent LTE/5G
                                                    </option>
                                                    <option value="4">
                                                        4 – strong, hotspot OK
                                                    </option>
                                                    <option value="5">
                                                        5 – stream all night
                                                    </option>
                                                </select>
                                            </div>
                                            <div>
                                                <label>Safety rating</label>
                                                <select
                                                    name="safetyRating"
                                                    value={
                                                        spotForm.safetyRating
                                                    }
                                                    onChange={
                                                        handleSpotInputChange
                                                    }
                                                >
                                                    <option value="0">
                                                        0 – would rather sleep
                                                        at my in-laws
                                                    </option>
                                                    <option value="1">
                                                        1 – only if absolutely
                                                        desperate
                                                    </option>
                                                    <option value="2">
                                                        2 – kinda sketchy but
                                                        survivable
                                                    </option>
                                                    <option value="3">
                                                        3 – fine with some
                                                        awareness
                                                    </option>
                                                    <option value="4">
                                                        4 – feels pretty safe
                                                        overall
                                                    </option>
                                                    <option value="5">
                                                        5 – would recommend to a
                                                        friend
                                                    </option>
                                                </select>
                                            </div>
                                        </div>

                                        <div className="form-group">
                                            <label>Noise level</label>
                                            <select
                                                name="noiseLevel"
                                                value={spotForm.noiseLevel}
                                                onChange={handleSpotInputChange}
                                            >
                                                <option value="very_quiet">
                                                    Very quiet / nature
                                                </option>
                                                <option value="quiet">
                                                    Quiet most of the time
                                                </option>
                                                <option value="some_road">
                                                    Some road noise
                                                </option>
                                                <option value="steady_noise">
                                                    Loud but steady (trucks,
                                                    generators)
                                                </option>
                                                <option value="party">
                                                    Party / unpredictable
                                                </option>
                                                <option value="unknown">
                                                    Not sure / didn&apos;t
                                                    notice
                                                </option>
                                            </select>
                                        </div>

                                        <div className="form-group">
                                            <label>
                                                Photo URLs (comma-separated)
                                            </label>
                                            <input
                                                type="text"
                                                name="photoUrls"
                                                value={spotForm.photoUrls}
                                                onChange={handleSpotInputChange}
                                                placeholder="https://..., https://..."
                                            />
                                            <p className="tiny-text">
                                                You can paste image URLs here.
                                                These will be stored alongside
                                                any uploaded photos.
                                            </p>
                                        </div>

                                        <div className="form-group">
                                            <label>Upload photos (optional)</label>
                                            <input
                                                ref={fileInputRef}
                                                type="file"
                                                multiple
                                                accept="image/*"
                                                onChange={handlePhotoFileChange}
                                            />
                                            <p className="tiny-text">
                                                Select 1–4 photos from your
                                                device. They’ll be uploaded to
                                                Supabase storage and linked to
                                                this spot.
                                            </p>
                                        </div>

                                        {errorMsg && (
                                            <p className="error-text">
                                                {errorMsg}
                                            </p>
                                        )}

                                        <div className="form-actions">
                                            <button
                                                type="button"
                                                className="btn-secondary"
                                                onClick={cancelAdding}
                                                disabled={
                                                    savingSpot ||
                                                    uploadingPhotos
                                                }
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                type="submit"
                                                className="btn-primary"
                                                disabled={
                                                    savingSpot ||
                                                    uploadingPhotos
                                                }
                                            >
                                                {savingSpot || uploadingPhotos
                                                    ? editMode
                                                        ? "Saving…"
                                                        : "Saving…"
                                                    : editMode
                                                        ? "Save changes"
                                                        : "Save Spot"}
                                            </button>
                                        </div>
                                    </form>
                                )}
                            </div>
                        )}

                        {/* Spot details + reviews */}
                        {!adding && selectedSpot && (
                            <div className="sheet-section">
                                <div className="sheet-title-row">
                                    <div className="sheet-title-main">
                                        <h2 className="sheet-title">
                                            {getSpotTypeIcon(
                                                selectedSpot.spot_type
                                            )}{" "}
                                            {selectedSpot.name}
                                        </h2>
                                        <button
                                            type="button"
                                            className={`fav-btn ${isFavorite(selectedSpot.id)
                                                    ? "fav-btn--active"
                                                    : ""
                                                }`}
                                            onClick={() =>
                                                toggleFavorite(selectedSpot.id)
                                            }
                                            aria-label={
                                                isFavorite(selectedSpot.id)
                                                    ? "Remove favorite"
                                                    : "Add favorite"
                                            }
                                        >
                                            ⭐
                                        </button>
                                    </div>
                                    <button
                                        type="button"
                                        className="sheet-close"
                                        onClick={() => setSelectedSpotId(null)}
                                        aria-label="Close details"
                                    >
                                        ✕
                                    </button>
                                </div>

                                <p className="sheet-subtitle">
                                    {selectedSpot.description}
                                </p>

                                <div className="sheet-meta-row">
                                    <span>
                                        {selectedSpotAverageRating
                                            ? `⭐ ${selectedSpotAverageRating.toFixed(
                                                1
                                            )}`
                                            : "No reviews yet"}
                                    </span>
                                    <span>
                                        Cell: {selectedSpot.cell_signal ?? 0}/5 ·
                                        Safety: {selectedSpot.safety_rating ?? 0}
                                        /5 · Noise:{" "}
                                        {formatNoiseLevel(
                                            selectedSpot.noise_level
                                        )}
                                    </span>
                                </div>

                                {selectedSpot.photo_urls &&
                                    selectedSpot.photo_urls.length > 0 && (
                                        <div className="photo-strip">
                                            {selectedSpot.photo_urls
                                                .slice(0, 4)
                                                .map((url, idx) => (
                                                    <img
                                                        key={idx}
                                                        src={url}
                                                        alt={`${selectedSpot.name} photo ${idx + 1
                                                            }`}
                                                        loading="lazy"
                                                        onClick={() =>
                                                            setActivePhoto({
                                                                url,
                                                                name: selectedSpot.name,
                                                            })
                                                        }
                                                    />
                                                ))}
                                        </div>
                                    )}

                                <div className="spot-actions">
                                    <button
                                        type="button"
                                        className="btn-secondary"
                                        onClick={() =>
                                            openSpotInMaps(selectedSpot)
                                        }
                                    >
                                        Open in Maps
                                    </button>
                                    <button
                                        type="button"
                                        className="btn-secondary"
                                        onClick={() =>
                                            startEditingSpot(selectedSpot)
                                        }
                                    >
                                        Edit spot
                                    </button>
                                </div>

                                <div className="reviews-block">
                                    <h3 className="reviews-title">Reviews</h3>
                                    {selectedSpotReviews.length === 0 && (
                                        <p className="small-text">
                                            No reviews yet. Be the first!
                                        </p>
                                    )}

                                    {selectedSpotReviews
                                        .slice(0, 6)
                                        .map((rev) => (
                                            <div
                                                key={rev.id}
                                                className="review-card"
                                            >
                                                <div className="review-header">
                                                    <span className="review-rating">
                                                        {"⭐".repeat(
                                                            rev.rating || 0
                                                        )}
                                                    </span>
                                                    <span className="review-name">
                                                        {rev.nickname || "Anon"}
                                                    </span>
                                                    <span className="review-date">
                                                        {rev.created_at
                                                            ? new Date(
                                                                rev.created_at
                                                            ).toLocaleDateString()
                                                            : ""}
                                                    </span>
                                                </div>
                                                <p className="review-comment">
                                                    {rev.comment}
                                                </p>
                                            </div>
                                        ))}
                                </div>

                                <form
                                    className="review-form"
                                    onSubmit={handleAddReview}
                                >
                                    <h3 className="reviews-title">
                                        Add a Review
                                    </h3>

                                    <div className="form-group inline">
                                        <div>
                                            <label>Rating (1–5)</label>
                                            <select
                                                name="rating"
                                                value={reviewForm.rating}
                                                onChange={
                                                    handleReviewInputChange
                                                }
                                            >
                                                <option value="5">
                                                    5 - Amazing
                                                </option>
                                                <option value="4">4 - Good</option>
                                                <option value="3">3 - Okay</option>
                                                <option value="2">
                                                    2 - Sketchy
                                                </option>
                                                <option value="1">
                                                    1 - Avoid
                                                </option>
                                            </select>
                                        </div>
                                        <div>
                                            <label>
                                                Nickname (optional)
                                            </label>
                                            <input
                                                type="text"
                                                name="nickname"
                                                value={reviewForm.nickname}
                                                onChange={
                                                    handleReviewInputChange
                                                }
                                                placeholder="Trail name / alias"
                                            />
                                        </div>
                                    </div>

                                    <div className="form-group">
                                        <label>Comment</label>
                                        <textarea
                                            name="comment"
                                            value={reviewForm.comment}
                                            onChange={
                                                handleReviewInputChange
                                            }
                                            placeholder="How was this spot? Safe? Noisy? Clean?"
                                            rows={3}
                                        />
                                    </div>

                                    {reviewError && (
                                        <p className="error-text">
                                            {reviewError}
                                        </p>
                                    )}

                                    <div className="form-actions">
                                        <button
                                            type="submit"
                                            className="btn-primary"
                                            disabled={savingReview}
                                        >
                                            {savingReview
                                                ? "Sending…"
                                                : "Post Review"}
                                        </button>
                                    </div>
                                </form>
                            </div>
                        )}

                        {/* Helpful prompt when nothing is selected */}
                        {!adding && !selectedSpot && (
                            <div className="sheet-section">
                                <h2 className="sheet-title">
                                    Explore the map
                                </h2>
                                <p className="small-text">
                                    Tap a pin to see details &amp; reviews, or
                                    tap <strong>Add Spot</strong> to share a
                                    safe place you&apos;ve stayed.
                                </p>
                            </div>
                        )}

                        {/* Account card */}
                        <div className="sheet-section">
                            <h2 className="sheet-title">Account</h2>
                            <p className="small-text">
                                {currentUser ? (
                                    <>
                                        Signed in as{" "}
                                        <strong>{currentUser.email}</strong>.
                                    </>
                                ) : (
                                    "You are not signed in. Login is optional – spots and reviews still work without an account."
                                )}
                            </p>
                            {currentUser && (
                                <p className="small-text">
                                    Right now login is optional – later we can
                                    use this to manage your spots, edit them,
                                    and sync favorites.
                                </p>
                            )}
                            <div className="spot-actions">
                                {currentUser ? (
                                    <button
                                        type="button"
                                        className="btn-secondary"
                                        onClick={handleSignOut}
                                        disabled={authBusy}
                                    >
                                        {authBusy
                                            ? "Signing out…"
                                            : "Sign out"}
                                    </button>
                                ) : (
                                    <button
                                        type="button"
                                        className="btn-primary"
                                        onClick={handleSignIn}
                                        disabled={authBusy}
                                    >
                                        {authBusy
                                            ? "Sending link…"
                                            : "Sign in"}
                                    </button>
                                )}
                            </div>
                        </div>

                        {/* About / links */}
                        <div className="sheet-section">
                            <h2 className="sheet-title">About &amp; Links</h2>
                            <p className="small-text">
                                Nomad Safe Spots is a free, community-driven map
                                built by{" "}
                                <span className="brand-name">Statusnone</span>{" "}
                                to help vanlifers and nomads find safe places to
                                park, rest, and reset.
                            </p>

                            <div className="social-links">
                                <a
                                    href="https://www.twitch.tv/statusnone"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    🎮 Twitch
                                </a>
                                <a
                                    href="https://www.youtube.com/@statusnone420"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    ▶️ YouTube
                                </a>
                                <a
                                    href="https://www.instagram.com/statusnone420/"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    📸 Instagram
                                </a>
                                <a
                                    href="https://x.com/Statusnone420"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    🐦 X / Twitter
                                </a>
                            </div>
                        </div>
                    </aside>
                </div>

                {/* Full-screen photo viewer */}
                {activePhoto && (
                    <div
                        className="photo-modal"
                        onClick={() => setActivePhoto(null)}
                    >
                        <div className="photo-modal-inner">
                            <img
                                src={activePhoto.url}
                                alt={activePhoto.name}
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}

export default App;
