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

// Fix default marker icon paths
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
    iconRetinaUrl: markerIcon2x,
    iconUrl: markerIcon,
    shadowUrl: markerShadow,
});

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

// Haversine distance in km (for "Spots nearby" list)
function haversineDistanceKm(a, b) {
    if (!a || !b) return null;
    const R = 6371;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLng = ((b.lng - a.lng) * Math.PI) / 180;
    const lat1 = (a.lat * Math.PI) / 180;
    const lat2 = (b.lat * Math.PI) / 180;

    const sinDLat = Math.sin(dLat / 2);
    const sinDLng = Math.sin(dLng / 2);

    const aa =
        sinDLat * sinDLat +
        Math.cos(lat1) * Math.cos(lat2) * sinDLng * sinDLng;
    const c = 2 * Math.atan2(Math.sqrt(aa), Math.sqrt(1 - aa));

    return R * c;
}

function formatNoiseLevel(level) {
    if (!level) return "Unknown";
    switch (level) {
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
        case "noisy":
            return "Noisy";
        default:
            return level;
    }
}

function getSpotTypeIcon(type) {
    switch (type) {
        case "forest_road":
            return "🌲";
        case "campground":
            return "🏕️";
        case "store":
            return "🛒";
        case "rest_area":
            return "🛣️";
        case "trailhead":
            return "🥾";
        case "other":
        default:
            return "📍";
    }
}

const FILTER_CHIPS = [
    { key: "any", label: "Any" },
    { key: "forest_road", label: "🌲 Forest" },
    { key: "campground", label: "🏕️ Campground" },
    { key: "store", label: "🛒 Store" },
    { key: "rest_area", label: "🛣️ Rest area" },
    { key: "trailhead", label: "🥾 Trailhead" },
];

const initialSpotForm = {
    name: "",
    description: "",
    overnightAllowed: false,
    hasBathroom: false,
    cellSignal: 3,
    safetyRating: 4,
    noiseLevel: "quiet",
    spotType: "forest_road",
    photoUrls: "",
};

const initialReviewForm = {
    rating: 5,
    comment: "",
    nickname: "",
};

function App() {
    // Spots / reviews
    const [spots, setSpots] = useState([]);
    const [reviews, setReviews] = useState([]);

    // Add / edit flow
    const [adding, setAdding] = useState(false);
    const [editingSpotId, setEditingSpotId] = useState(null);
    const [pendingLocation, setPendingLocation] = useState(null);
    const [spotForm, setSpotForm] = useState(initialSpotForm);
    const [spotPhotoFiles, setSpotPhotoFiles] = useState([]);
    const [uploadingPhotos, setUploadingPhotos] = useState(false);
    const [selectedSpotId, setSelectedSpotId] = useState(null);

    // Reviews
    const [reviewForm, setReviewForm] = useState(initialReviewForm);
    const [savingSpot, setSavingSpot] = useState(false);
    const [savingReview, setSavingReview] = useState(false);
    const [status, setStatus] = useState("Connecting to Supabase…");
    const [errorMsg, setErrorMsg] = useState("");
    const [reviewError, setReviewError] = useState("");
    const [darkMode, setDarkMode] = useState(true);
    const [activePhoto, setActivePhoto] = useState(null);
    const [userLocation, setUserLocation] = useState(null);

    // Filters
    const [filterType, setFilterType] = useState("any");
    const [filterOvernightOnly, setFilterOvernightOnly] = useState(false);
    const [filterFavoritesOnly, setFilterFavoritesOnly] = useState(false);

    // Map layer
    const [mapLayer, setMapLayer] = useState("satellite");

    // Favorites (local)
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

    // Auth
    const [session, setSession] = useState(null);
    const [isMobileSheetOpen, setIsMobileSheetOpen] = useState(false);

    const isMobileViewport =
        typeof window !== "undefined" && window.innerWidth <= 768;

    const [authEmail, setAuthEmail] = useState("");
    const [authLoading, setAuthLoading] = useState(false);
    const [authError, setAuthError] = useState("");

    // Map ref
    const mapRef = useRef(null);
    const center = [39.5, -98.35]; // Center of US

    /* ---------- EFFECTS ---------- */

    // Load spots + reviews
    useEffect(() => {
        async function loadData() {
            setStatus("Loading spots and reviews from Supabase…");

            const [spotsRes, reviewsRes] = await Promise.all([
                supabase
                    .from("spots")
                    .select(
                        "id, name, description, lat, lng, overnight_allowed, has_bathroom, cell_signal, noise_level, safety_rating, spot_type, created_at, photo_urls"
                    )
                    .order("created_at", { ascending: false }),
                supabase
                    .from("reviews")
                    .select(
                        "id, spot_id, rating, comment, nickname, created_at"
                    )
                    .order("created_at", { ascending: false }),
            ]);

            if (spotsRes.error) {
                console.error(spotsRes.error);
                setStatus("Error loading spots");
                setErrorMsg(spotsRes.error.message);
                return;
            }

            if (reviewsRes.error) {
                console.error(reviewsRes.error);
                setStatus("Error loading reviews");
                setErrorMsg(reviewsRes.error.message);
                return;
            }

            let loadedSpots = spotsRes.data ?? [];

            // Normalize photo_urls
            loadedSpots = loadedSpots.map((spot) => {
                let { photo_urls } = spot;
                if (!photo_urls) {
                    photo_urls = [];
                } else {
                    if (Array.isArray(photo_urls)) {
                        // ok as-is
                    } else if (
                        typeof photo_urls === "string" &&
                        photo_urls.trim().length > 0
                    ) {
                        // handle legacy comma-separated string
                        try {
                            // if it's actually JSON, parse it; otherwise treat as CSV
                            const maybeJson = JSON.parse(photo_urls);
                            if (Array.isArray(maybeJson)) {
                                photo_urls = maybeJson;
                            } else {
                                photo_urls = photo_urls
                                    .split(",")
                                    .map((s) => s.trim())
                                    .filter(Boolean);
                            }
                        } catch {
                            photo_urls = photo_urls
                                .split(",")
                                .map((s) => s.trim())
                                .filter(Boolean);
                        }
                    } else {
                        photo_urls = [];
                    }
                }
                return { ...spot, photo_urls };
            });

            setSpots(loadedSpots);
            setReviews(reviewsRes.data ?? []);

            setStatus("Loaded spots & reviews. Tap the map to explore.");
            setErrorMsg("");
        }

        loadData();
    }, []);

    // Auth session
    useEffect(() => {
        async function getSession() {
            const { data, error } = await supabase.auth.getSession();
            if (error) {
                console.error(error);
                return;
            }
            setSession(data.session ?? null);
        }

        getSession();

        const {
            data: { subscription },
        } = supabase.auth.onAuthStateChange((_event, session) => {
            setSession(session);
        });

        return () => subscription.unsubscribe();
    }, []);

    // Get user location
    useEffect(() => {
        if (!navigator.geolocation) return;

        const watchId = navigator.geolocation.watchPosition(
            (pos) => {
                setUserLocation({
                    lat: pos.coords.latitude,
                    lng: pos.coords.longitude,
                });
            },
            (err) => {
                console.warn("Geolocation error:", err);
            },
            {
                enableHighAccuracy: true,
                maximumAge: 30_000,
                timeout: 20_000,
            }
        );

        return () => navigator.geolocation.clearWatch(watchId);
    }, []);

    // Persist favorites
    useEffect(() => {
        try {
            const arr = Array.from(favoriteIds);
            window.localStorage.setItem(
                "nomad_safe_spots_favorites",
                JSON.stringify(arr)
            );
        } catch (err) {
            console.warn("Error saving favorites:", err);
        }
    }, [favoriteIds]);

    /* ---------- DERIVED DATA ---------- */

    const reviewsBySpotId = useMemo(() => {
        const map = new Map();
        for (const review of reviews) {
            if (!review.spot_id) continue;
            if (!map.has(review.spot_id)) map.set(review.spot_id, []);
            map.get(review.spot_id).push(review);
        }
        return map;
    }, [reviews]);

    const spotsWithStats = useMemo(() => {
        return (spots ?? [])
            .map((spot) => {
                const revs = reviewsBySpotId.get(spot.id) ?? [];
                const avgRating =
                    revs.length > 0
                        ? revs.reduce((sum, r) => sum + (r.rating ?? 0), 0) /
                        revs.length
                        : null;
                const reviewCount = revs.length;

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
    }, [spots, reviewsBySpotId, userLocation, favoriteIds]);

    const filteredSpots = useMemo(() => {
        return spotsWithStats.filter((spot) => {
            if (filterType !== "any" && spot.spot_type !== filterType) {
                return false;
            }
            if (filterOvernightOnly && !spot.overnight_allowed) {
                return false;
            }
            if (filterFavoritesOnly && !favoriteIds.has(spot.id)) {
                return false;
            }
            return true;
        });
    }, [
        spotsWithStats,
        filterType,
        filterOvernightOnly,
        filterFavoritesOnly,
        favoriteIds,
    ]);

    const selectedSpot = useMemo(
        () => spotsWithStats.find((s) => s.id === selectedSpotId) || null,
        [spotsWithStats, selectedSpotId]
    );

    const selectedSpotReviews = useMemo(
        () => reviewsBySpotId.get(selectedSpotId) ?? [],
        [reviewsBySpotId, selectedSpotId]
    );

    const isFavorite = (spotId) => favoriteIds.has(spotId);

    /* ---------- HANDLERS ---------- */

    function startAdding() {
        setAdding(true);
        setEditingSpotId(null);
        setPendingLocation(null);
        setSpotForm(initialSpotForm);
        setSpotPhotoFiles([]);
        setErrorMsg("");
        // On mobile, collapse the drawer so it's easy to tap the map first
        if (isMobileViewport) {
            setIsMobileSheetOpen(false);
        }
    }

    function cancelAddOrEdit() {
        setAdding(false);
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
        // When a location is picked on mobile, spring the drawer back open
        if (isMobileViewport) {
            setIsMobileSheetOpen(true);
        }
    }

    function handleSpotInputChange(e) {
        const { name, value } = e.target;
        setSpotForm((prev) => ({
            ...prev,
            [name]: value,
        }));
    }

    function handleSpotFileChange(e) {
        const files = Array.from(e.target.files || []);
        setSpotPhotoFiles(files);
    }

    function handleReviewInputChange(e) {
        const { name, value } = e.target;
        setReviewForm((prev) => ({
            ...prev,
            [name]: value,
        }));
    }

    async function handleSaveSpot(e) {
        e.preventDefault();
        setErrorMsg("");

        if (!pendingLocation) {
            setErrorMsg("Tap on the map to choose a location.");
            return;
        }

        if (!spotForm.name.trim()) {
            setErrorMsg("Please give this spot a name.");
            return;
        }

        setSavingSpot(true);

        const lat = pendingLocation.lat;
        const lng = pendingLocation.lng;
        const cell_signal = clamp(
            parseInt(spotForm.cellSignal, 10) || 0,
            0,
            5
        );
        const safety_rating = clamp(
            parseInt(spotForm.safetyRating, 10) || 0,
            1,
            5
        );

        let photo_urls = [];
        // parse any manual URLs typed in
        if (spotForm.photoUrls) {
            photo_urls = spotForm.photoUrls
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        }

        // upload any local files
        let uploadedUrls = [];
        if (spotPhotoFiles.length > 0) {
            setUploadingPhotos(true);

            for (const file of spotPhotoFiles) {
                const ext = file.name.split(".").pop();
                const fileName = `${Date.now()}-${Math.random()
                    .toString(36)
                    .slice(2)}.${ext}`;

                const { data, error } = await supabase.storage
                    .from("spot-photos")
                    .upload(fileName, file, {
                        cacheControl: "3600",
                        upsert: false,
                    });

                if (error) {
                    console.error(error);
                    setErrorMsg(
                        "Failed to upload one of the photos: " + error.message
                    );
                    setUploadingPhotos(false);
                    return;
                }

                if (data?.path) {
                    const {
                        data: { publicUrl },
                    } = supabase.storage
                        .from("spot-photos")
                        .getPublicUrl(data.path);

                    if (publicUrl) uploadedUrls.push(publicUrl);
                }
            }

            setUploadingPhotos(false);
        }

        const allPhotoUrls = [...photo_urls, ...uploadedUrls];

        const payload = {
            name: spotForm.name.trim(),
            description: spotForm.description.trim(),
            lat,
            lng,
            overnight_allowed: spotForm.overnightAllowed,
            has_bathroom: spotForm.hasBathroom,
            cell_signal,
            safety_rating,
            noise_level: spotForm.noiseLevel,
            spot_type: spotForm.spotType,
            photo_urls: allPhotoUrls,
        };

        try {
            let result;
            if (editingSpotId) {
                result = await supabase
                    .from("spots")
                    .update(payload)
                    .eq("id", editingSpotId)
                    .select()
                    .single();
            } else {
                result = await supabase
                    .from("spots")
                    .insert(payload)
                    .select()
                    .single();
            }

            if (result.error) {
                console.error(result.error);
                setErrorMsg(result.error.message);
                return;
            }

            const savedSpot = result.data;
            setSpots((prev) => {
                const idx = prev.findIndex((s) => s.id === savedSpot.id);
                if (idx === -1) return [savedSpot, ...prev];
                const copy = [...prev];
                copy[idx] = savedSpot;
                return copy;
            });

            setAdding(false);
            setEditingSpotId(null);
            setPendingLocation(null);
            setSpotForm(initialSpotForm);
            setSpotPhotoFiles([]);
            setErrorMsg("");
            setStatus(
                editingSpotId ? "Spot updated successfully." : "Spot added!"
            );
        } catch (err) {
            console.error(err);
            setErrorMsg(err.message || "Error saving spot.");
        } finally {
            setSavingSpot(false);
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

        const payload = {
            spot_id: selectedSpot.id,
            rating,
            comment: reviewForm.comment.trim(),
            nickname: reviewForm.nickname.trim() || null,
        };

        try {
            setSavingReview(true);
            const { data, error } = await supabase
                .from("reviews")
                .insert(payload)
                .select()
                .single();

            if (error) {
                console.error(error);
                setReviewError(error.message);
                return;
            }

            setReviews((prev) => [data, ...prev]);
            setReviewForm(initialReviewForm);
        } catch (err) {
            console.error(err);
            setReviewError(err.message || "Error saving review.");
        } finally {
            setSavingReview(false);
        }
    }

    async function handleLocateMe() {
        if (!mapRef.current) return;
        if (!navigator.geolocation) {
            setStatus("Geolocation is not supported by your browser.");
            return;
        }

        setStatus("Finding your location…");

        navigator.geolocation.getCurrentPosition(
            (pos) => {
                const { latitude, longitude } = pos.coords;
                setUserLocation({ lat: latitude, lng: longitude });

                const map = mapRef.current;
                map.setView([latitude, longitude], 11, {
                    animate: true,
                });

                setStatus("Centered on your location.");
            },
            (err) => {
                console.error(err);
                setStatus("Unable to get your location.");
            },
            {
                enableHighAccuracy: true,
                maximumAge: 30_000,
                timeout: 20_000,
            }
        );
    }

    function openSpotInMaps(spot) {
        if (!spot) return;
        const url = `https://www.google.com/maps?q=${spot.lat},${spot.lng}`;
        window.open(url, "_blank");
    }

    async function handleLogin(e) {
        e.preventDefault();
        setAuthError("");
        if (!authEmail.trim()) {
            setAuthError("Please enter an email.");
            return;
        }

        setAuthLoading(true);
        try {
            const { error } = await supabase.auth.signInWithOtp({
                email: authEmail.trim(),
                options: {
                    emailRedirectTo: window.location.href,
                },
            });

            if (error) {
                console.error(error);
                setAuthError(error.message);
                return;
            }

            setStatus("Check your email for a magic login link.");
        } catch (err) {
            console.error(err);
            setAuthError(err.message || "Error sending magic link.");
        } finally {
            setAuthLoading(false);
        }
    }

    async function handleLogout() {
        try {
            await supabase.auth.signOut();
            setSession(null);
        } catch (err) {
            console.error(err);
        }
    }

    function toggleFavorite(spotId) {
        setFavoriteIds((prev) => {
            const next = new Set(prev);
            if (next.has(spotId)) next.delete(spotId);
            else next.add(spotId);
            return next;
        });
    }

    function startEditingSpot(spot) {
        if (!spot) return;
        setAdding(true);
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
            spotType: spot.spot_type || "other",
            photoUrls: Array.isArray(spot.photo_urls)
                ? spot.photo_urls.join(", ")
                : "",
        });
    }

    const appClassName = `${darkMode ? "app glass dark" : "app glass"
        }${isMobileSheetOpen ? " mobile-sheet-open" : ""}`;

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
                            className="btn-ghost"
                            type="button"
                            onClick={handleLocateMe}
                        >
                            📍 My location
                        </button>
                        <button
                            className={`btn-ghost ${!darkMode ? "btn-ghost--active" : ""
                                }`}
                            type="button"
                            onClick={() => setDarkMode((d) => !d)}
                        >
                            {darkMode ? "☀️ Light" : "🌙 Dark"}
                        </button>
                    </div>
                </div>

                <p className="status-text">{status}</p>

                <div className="header-actions">
                    <button className="btn-primary" onClick={startAdding}>
                        ➕ Add Spot
                    </button>
                </div>

                {/* Emoji filter chips */}
                <div className="chip-filter-row">
                    {FILTER_CHIPS.map(({ key, label }) => {
                        const isActive = filterType === key;
                        return (
                            <button
                                key={key}
                                type="button"
                                className={`filter-chip chip-pill ${isActive ? "filter-chip--active" : ""
                                    }`}
                                onClick={() => setFilterType(key)}
                            >
                                {label}
                            </button>
                        );
                    })}
                    <button
                        type="button"
                        className={`filter-chip chip-pill ${filterFavoritesOnly ? "filter-chip--active" : ""
                            }`}
                        onClick={() =>
                            setFilterFavoritesOnly((prev) => !prev)
                        }
                    >
                        ⭐ Favorites
                    </button>
                </div>

                {/* Filters row */}
                <div className="filters-row">
                    <div className="filters-group">
                        <span className="filters-label">Type</span>
                        <select
                            className="filters-select"
                            value={filterType}
                            onChange={(e) => setFilterType(e.target.value)}
                        >
                            <option value="any">Any</option>
                            <option value="forest_road">Forest road</option>
                            <option value="campground">Campground</option>
                            <option value="store">Store</option>
                            <option value="rest_area">Rest area</option>
                            <option value="trailhead">Trailhead</option>
                        </select>
                    </div>

                    <label className="filters-toggle">
                        <input
                            type="checkbox"
                            checked={filterOvernightOnly}
                            onChange={(e) =>
                                setFilterOvernightOnly(e.target.checked)
                            }
                        />{" "}
                        Overnight only
                    </label>
                </div>

                {/* Map layer toggle */}
                <div className="map-layer-toggle-row">
                    <div className="map-layer-toggle">
                        <button
                            type="button"
                            className={`filter-chip chip-pill ${mapLayer === "satellite"
                                    ? "filter-chip--active"
                                    : ""
                                }`}
                            onClick={() => setMapLayer("satellite")}
                        >
                            🛰 Satellite
                        </button>
                        <button
                            type="button"
                            className={`filter-chip chip-pill ${mapLayer === "streets"
                                    ? "filter-chip--active"
                                    : ""
                                }`}
                            onClick={() => setMapLayer("streets")}
                        >
                            🗺 Streets
                        </button>
                    </div>
                </div>
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
                                attribution={
                                    mapLayer === "streets"
                                        ? "&copy; OpenStreetMap contributors"
                                        : "Imagery &copy; Esri"
                                }
                                url={
                                    mapLayer === "streets"
                                        ? "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                                        : "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                                }
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
                                                {spot.avgRating != null ? (
                                                    <>
                                                        ★{" "}
                                                        {spot.avgRating.toFixed(
                                                            1
                                                        )}{" "}
                                                        ({spot.reviewCount}{" "}
                                                        reviews)
                                                    </>
                                                ) : (
                                                    "No reviews yet"
                                                )}
                                            </div>
                                            {spot.distanceKm != null && (
                                                <div>
                                                    Distance:{" "}
                                                    {spot.distanceKm < 1
                                                        ? `${Math.round(
                                                            spot.distanceKm *
                                                            1000
                                                        )} m`
                                                        : `${spot.distanceKm.toFixed(
                                                            1
                                                        )} km`}
                                                </div>
                                            )}
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
                                        {editingSpotId
                                            ? "Editing spot location"
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
                            <AddSpotOnClick
                                active={adding}
                                onMapClick={handleMapClick}
                            />
                        </MapContainer>
                    </div>
                </div>

                <aside className="side-column">
                    {/* SPOTS NEARBY CARD */}
                    <div className="spot-list-panel">
                        <div className="spot-list-header">
                            <h2 className="spot-list-title">Spots nearby</h2>
                            <span className="spot-list-count">
                                {filteredSpots.length} results
                            </span>
                        </div>
                        <div className="spot-list-body">
                            {filteredSpots.length === 0 && (
                                <p className="spot-list-empty">
                                    No spots match your filters yet.
                                </p>
                            )}

                            {filteredSpots.map((spot) => {
                                const isSelected =
                                    selectedSpotId === spot.id;
                                const favorite = isFavorite(spot.id);
                                const typeLabel =
                                    FILTER_CHIPS.find(
                                        (c) => c.key === spot.spot_type
                                    )?.label || "Other";

                                return (
                                    <button
                                        key={spot.id}
                                        type="button"
                                        className={`spot-list-item ${isSelected
                                                ? "spot-list-item--active"
                                                : ""
                                            }`}
                                        onClick={() =>
                                            setSelectedSpotId(spot.id)
                                        }
                                    >
                                        <div className="spot-list-item-main">
                                            <div className="spot-list-item-title-row">
                                                <span className="spot-list-item-name">
                                                    {spot.name}
                                                </span>
                                                {favorite && (
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
                                                            ({spot.reviewCount})
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
                        </div>
                    </div>

                    {/* ADD / EDIT SPOT CARD */}
                    <div className="sheet">
                        <div className="sheet-section">
                            <div className="sheet-title-row">
                                <div className="sheet-title-main">
                                    <h2 className="sheet-title">
                                        {editingSpotId
                                            ? "Edit spot"
                                            : "Add a new spot"}
                                    </h2>
                                </div>
                                <button
                                    type="button"
                                    className="btn-secondary"
                                    onClick={startAdding}
                                >
                                    ➕ Start
                                </button>
                            </div>

                            {!adding && (
                                <p className="sheet-subtitle">
                                    Tap <strong>Add Spot</strong>, then tap the
                                    map where you stayed. Once the pin is
                                    placed, fill in the details below.
                                </p>
                            )}

                            {adding && (
                                <>
                                    {!pendingLocation && (
                                        <p className="small-text highlight">
                                            Tap on the map to pick a location,
                                            then fill in the details below.
                                        </p>
                                    )}

                                    {pendingLocation && (
                                        <p className="small-text">
                                            Location selected:
                                            <br />
                                            Lat:{" "}
                                            {pendingLocation.lat.toFixed(4)},
                                            Lng:{" "}
                                            {pendingLocation.lng.toFixed(4)}
                                        </p>
                                    )}

                                    {errorMsg && (
                                        <p className="error-text">
                                            {errorMsg}
                                        </p>
                                    )}

                                    <form
                                        onSubmit={handleSaveSpot}
                                        className="spot-form"
                                    >
                                        <div className="form-group">
                                            <label>Name</label>
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
                                                <option value="forest_road">
                                                    Forest road / public land
                                                </option>
                                                <option value="campground">
                                                    Campground
                                                </option>
                                                <option value="store">
                                                    Store / parking lot
                                                </option>
                                                <option value="rest_area">
                                                    Rest area
                                                </option>
                                                <option value="trailhead">
                                                    Trailhead
                                                </option>
                                                <option value="other">
                                                    Other
                                                </option>
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
                                                                e.target.checked,
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
                                                    checked={
                                                        spotForm.hasBathroom
                                                    }
                                                    onChange={(e) =>
                                                        setSpotForm((prev) => ({
                                                            ...prev,
                                                            hasBathroom:
                                                                e.target.checked,
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
                                                    onChange={handleSpotInputChange}
                                                >
                                                    <option value="0">
                                                        0 – no service at all
                                                    </option>
                                                    <option value="1">
                                                        1 – very weak
                                                    </option>
                                                    <option value="2">
                                                        2 – spotty
                                                    </option>
                                                    <option value="3">
                                                        3 – usable
                                                    </option>
                                                    <option value="4">
                                                        4 – good
                                                    </option>
                                                    <option value="5">
                                                        5 – strong
                                                    </option>
                                                </select>
                                            </div>
                                            <div>
                                                <label>Safety rating</label>
                                                <select
                                                    name="safetyRating"
                                                    value={spotForm.safetyRating}
                                                    onChange={handleSpotInputChange}
                                                >
                                                    <option value="1">
                                                        1 – felt unsafe
                                                    </option>
                                                    <option value="2">
                                                        2 – sketchy
                                                    </option>
                                                    <option value="3">
                                                        3 – okay
                                                    </option>
                                                    <option value="4">
                                                        4 – pretty safe overall
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
                                            </select>
                                        </div>

                                        <div className="form-group">
                                            <label>
                                                Extra photo URLs (comma
                                                separated)
                                            </label>
                                            <input
                                                type="text"
                                                name="photoUrls"
                                                value={spotForm.photoUrls}
                                                onChange={handleSpotInputChange}
                                                placeholder="https://image1.jpg, https://image2.jpg"
                                            />
                                            <p className="tiny-text">
                                                Optional: paste direct image
                                                links if you already host photos
                                                somewhere.
                                            </p>
                                        </div>

                                        <div className="form-group">
                                            <label>Upload photos</label>
                                            <input
                                                type="file"
                                                accept="image/*"
                                                multiple
                                                onChange={handleSpotFileChange}
                                            />
                                            <p className="tiny-text">
                                                You can add up to a few photos
                                                from your phone or laptop.
                                            </p>
                                        </div>

                                        <div className="form-actions">
                                            <button
                                                type="button"
                                                className="btn-secondary"
                                                onClick={cancelAddOrEdit}
                                                disabled={
                                                    savingSpot || uploadingPhotos
                                                }
                                            >
                                                Cancel
                                            </button>
                                            <button
                                                type="submit"
                                                className="btn-primary"
                                                disabled={
                                                    savingSpot || uploadingPhotos
                                                }
                                            >
                                                {uploadingPhotos
                                                    ? "Uploading photos…"
                                                    : savingSpot
                                                        ? "Saving…"
                                                        : editingSpotId
                                                            ? "Save changes"
                                                            : "Save Spot"}
                                            </button>
                                        </div>
                                    </form>
                                </>
                            )}
                        </div>

                        {/* SPOT DETAIL + REVIEWS CARD */}
                        {selectedSpot && (
                            <div className="sheet-section">
                                <div className="sheet-title-row">
                                    <div className="sheet-title-main">
                                        <h2 className="sheet-title">
                                            {selectedSpot.name.toUpperCase()}
                                        </h2>
                                        <button
                                            type="button"
                                            className={`fav-btn ${favoriteIds.has(selectedSpot.id)
                                                    ? "fav-btn--active"
                                                    : ""
                                                }`}
                                            onClick={() =>
                                                toggleFavorite(selectedSpot.id)
                                            }
                                        >
                                            ⭐
                                        </button>
                                    </div>
                                    <button
                                        type="button"
                                        className="sheet-close"
                                        onClick={() => setSelectedSpotId(null)}
                                    >
                                        ✕
                                    </button>
                                </div>

                                <p className="sheet-subtitle">
                                    {selectedSpot.description}
                                </p>

                                <div className="sheet-meta-row">
                                    <span>
                                        {selectedSpot.overnight_allowed
                                            ? "✅ Overnight parking OK"
                                            : "🚫 Overnight not allowed or unclear"}
                                    </span>
                                    <span>
                                        {selectedSpot.has_bathroom
                                            ? "🚻 Bathrooms available"
                                            : "🚻 No bathrooms listed"}
                                    </span>
                                    <span>
                                        {selectedSpot.avgRating != null
                                            ? `★ ${selectedSpot.avgRating.toFixed(
                                                1
                                            )} (${selectedSpot.reviewCount} reviews)`
                                            : "No reviews yet"}
                                    </span>
                                    <span>
                                        Cell:{" "}
                                        {selectedSpot.cell_signal ?? 0}/5 ·
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
                                            No reviews yet. Be the first to
                                            share your experience.
                                        </p>
                                    )}

                                    {selectedSpotReviews.map((rev) => (
                                        <div key={rev.id} className="review-card">
                                            <div className="review-header">
                                                <span className="review-rating">
                                                    ★ {rev.rating}/5
                                                </span>
                                                <span className="review-name">
                                                    {rev.nickname || "Anonymous"}
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
                                                    <option value="1">1</option>
                                                    <option value="2">2</option>
                                                    <option value="3">3</option>
                                                    <option value="4">4</option>
                                                    <option value="5">5</option>
                                                </select>
                                            </div>
                                            <div>
                                                <label>Nickname (optional)</label>
                                                <input
                                                    type="text"
                                                    name="nickname"
                                                    value={reviewForm.nickname}
                                                    onChange={
                                                        handleReviewInputChange
                                                    }
                                                    placeholder="E.g. Vanlife Sam"
                                                />
                                            </div>
                                        </div>

                                        <div className="form-group">
                                            <label>Comment</label>
                                            <textarea
                                                name="comment"
                                                value={reviewForm.comment}
                                                onChange={handleReviewInputChange}
                                                placeholder="What was this spot like?"
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
                            </div>
                        )}

                        {/* EXPLORE CARD */}
                        <div className="sheet-section">
                            <h2 className="sheet-title">Explore the map</h2>
                            <p className="sheet-subtitle">
                                Tap a pin to see details &amp; reviews, or tap{" "}
                                <strong>Add Spot</strong> to share a safe place
                                you&apos;ve stayed.
                            </p>
                        </div>

                        {/* ACCOUNT CARD */}
                        <div className="sheet-section">
                            <h2 className="sheet-title">Account</h2>

                            {session ? (
                                <>
                                    <p className="small-text">
                                        Logged in as{" "}
                                        <strong>
                                            {session.user.email || "you"}
                                        </strong>
                                        .
                                    </p>
                                    <button
                                        type="button"
                                        className="btn-secondary"
                                        onClick={handleLogout}
                                    >
                                        Log out
                                    </button>
                                </>
                            ) : (
                                <form
                                    className="spot-form"
                                    onSubmit={handleLogin}
                                >
                                    <p className="small-text">
                                        Sign in with a magic link so you can add
                                        and edit your own spots. No passwords.
                                    </p>
                                    <div className="form-group">
                                        <label>Email for login</label>
                                        <input
                                            type="email"
                                            value={authEmail}
                                            onChange={(e) =>
                                                setAuthEmail(e.target.value)
                                            }
                                            placeholder="you@example.com"
                                        />
                                    </div>
                                    {authError && (
                                        <p className="error-text">{authError}</p>
                                    )}
                                    <div className="form-actions">
                                        <button
                                            type="submit"
                                            className="btn-primary"
                                            disabled={authLoading}
                                        >
                                            {authLoading
                                                ? "Sending link…"
                                                : "Send magic link"}
                                        </button>
                                    </div>
                                </form>
                            )}
                        </div>

                        {/* ABOUT CARD */}
                        <div className="sheet-section">
                            <h2 className="sheet-title">About &amp; Links</h2>
                            <p className="small-text">
                                Nomad Safe Spots is a free, community-driven map
                                built by{" "}
                                <span className="brand-name">Statusnone</span> to
                                help vanlifers and nomads find safe places to park,
                                rest, and reset.
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

                            <p className="small-text">
                                If this app helped you find a safe night&apos;s
                                sleep and you&apos;d like to say thanks, you can{" "}
                                <a
                                    href="https://cash.app/$statusnone/5"
                                    target="_blank"
                                    rel="noreferrer"
                                >
                                    buy Status a coffee or some Rose Orbs ($5)
                                </a>
                                .
                            </p>
                        </div>
                    </div>
                </aside>
            </div>

            {/* Mobile slide-over controls */}
            <button
                type="button"
                className="mobile-sheet-backdrop"
                aria-label="Close spots drawer"
                onClick={() => setIsMobileSheetOpen(false)}
            />
            <button
                type="button"
                className="mobile-spots-toggle"
                onClick={() => setIsMobileSheetOpen((open) => !open)}
                aria-label={
                    isMobileSheetOpen
                        ? "Hide spots and details"
                        : "Show spots and details"
                }
            >
                {isMobileSheetOpen ? "Hide spots ▾" : "Spots & details ▴"}
            </button>

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
    );
}

export default App;
