import { useEffect, useMemo, useState } from "react";
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

// Map from spot_type -> emoji/icon
function getSpotTypeIcon(type) {
    const t = (type || "other").toLowerCase();
    if (t === "forest_road") return "🌲";
    if (t === "walmart") return "🛒";
    if (t === "rest_area") return "🛣️";
    if (t === "city_stealth") return "🏙️";
    if (t === "campground") return "🏕️";
    if (t === "scenic_view") return "🌄";
    return "📍";
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
    const [adding, setAdding] = useState(false);
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
    const [darkMode, setDarkMode] = useState(false);

    const center = [39.5, -98.35]; // Center of US

    // Load existing spots + reviews from Supabase on first render
    useEffect(() => {
        async function loadData() {
            setStatus("Loading spots and reviews from Supabase…");

            const [spotsRes, reviewsRes] = await Promise.all([
                supabase.from("spots").select("*").order("id", { ascending: true }),
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
                    `Connected. Spots: ${spotsRes.data?.length || 0}, Reviews: ${reviewsRes.data?.length || 0
                    }`
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
        const sum = selectedSpotReviews.reduce((acc, r) => acc + (r.rating || 0), 0);
        return sum / selectedSpotReviews.length;
    }, [selectedSpotReviews]);

    function startAdding() {
        setAdding(true);
        setPendingLocation(null);
        setSpotForm(initialSpotForm);
        setErrorMsg("");
    }

    function cancelAdding() {
        setAdding(false);
        setPendingLocation(null);
        setSpotForm(initialSpotForm);
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

    async function handleSaveSpot(e) {
        e.preventDefault();
        setErrorMsg("");

        if (!adding) {
            setErrorMsg("Tap “Add Spot” first.");
            return;
        }

        if (!pendingLocation) {
            setErrorMsg("Tap on the map to choose a location.");
            return;
        }

        if (!spotForm.name.trim()) {
            setErrorMsg("Name is required.");
            return;
        }

        const { lat, lng } = pendingLocation;
        const cell_signal = clamp(parseInt(spotForm.cellSignal, 10) || 0, 0, 5);
        const safety_rating = clamp(
            parseInt(spotForm.safetyRating, 10) || 0,
            0,
            5
        );
        const noise_level = spotForm.noiseLevel || "unknown";
        const spot_type = spotForm.spotType || "other";

        let photo_urls = [];
        if (spotForm.photoUrls.trim()) {
            photo_urls = spotForm.photoUrls
                .split(",")
                .map((u) => u.trim())
                .filter(Boolean);
        }

        setSavingSpot(true);

        const { data, error } = await supabase
            .from("spots")
            .insert({
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
                photo_urls,
            })
            .select()
            .single();

        setSavingSpot(false);

        if (error) {
            console.error("Error saving spot:", error);
            setErrorMsg("Failed to save spot: " + error.message);
            return;
        }

        setSpots((prev) => [...prev, data]);
        setSelectedSpotId(data.id);
        cancelAdding();
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

    const appClassName = darkMode ? "app glass dark" : "app glass";

    return (
        <div className={appClassName}>
            <header className="app-header">
                <div className="brand-row">
                    <div>
                        <h1>Nomad Safe Spots</h1>
                        <p className="subtitle">
                            Liquid-glass map of safe parking & rest spots – free, community-powered.
                        </p>
                        <p className="brand-by">
                            Crafted by <span className="brand-name">Statusnone</span>
                        </p>
                    </div>
                    <div className="header-controls">
                        <button
                            type="button"
                            className="btn-ghost"
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
                        >
                            <TileLayer
                                attribution="&copy; OpenStreetMap contributors"
                                url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                            />

                            <AddSpotOnClick active={adding} onMapClick={handleMapClick} />

                            {spots.map((spot) => (
                                <Marker
                                    key={spot.id}
                                    position={[spot.lat, spot.lng]}
                                    eventHandlers={{
                                        click: () => setSelectedSpotId(spot.id),
                                    }}
                                >
                                    <Popup>
                                        <strong>
                                            {getSpotTypeIcon(spot.spot_type)} {spot.name}
                                        </strong>
                                        <br />
                                        {spot.description}
                                        <br />
                                        <small>
                                            Lat: {spot.lat.toFixed(4)}, Lng: {spot.lng.toFixed(4)}
                                        </small>
                                        <br />
                                        <br />
                                        <div className="popup-meta">
                                            <div>
                                                Type:{" "}
                                                {(spot.spot_type || "other")
                                                    .replace("_", " ")
                                                    .replace(/\b\w/g, (c) => c.toUpperCase())}
                                            </div>
                                            <div>
                                                Overnight allowed:{" "}
                                                {spot.overnight_allowed ? "Yes" : "No / unknown"}
                                            </div>
                                            <div>
                                                Bathrooms:{" "}
                                                {spot.has_bathroom ? "Yes" : "No / nearby / ?"}
                                            </div>
                                            <div>Cell: {spot.cell_signal ?? 0} / 5 bars</div>
                                            <div>Noise: {spot.noise_level || "unknown"}</div>
                                            <div>Safety: {spot.safety_rating ?? 0} / 5</div>
                                        </div>
                                    </Popup>
                                </Marker>
                            ))}

                            {adding && pendingLocation && (
                                <Marker position={[pendingLocation.lat, pendingLocation.lng]}>
                                    <Popup>New spot location (not saved yet)</Popup>
                                </Marker>
                            )}
                        </MapContainer>
                    </div>
                </div>

                {/* Bottom sheet / sidebar for mobile + desktop */}
                <aside className="sheet">
                    {/* When adding a spot */}
                    {adding && (
                        <div className="sheet-section">
                            <h2 className="sheet-title">Add a New Spot</h2>

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
                                <form className="spot-form" onSubmit={handleSaveSpot}>
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
                                            <option value="forest_road">Forest road / BLM</option>
                                            <option value="campground">Campground</option>
                                            <option value="walmart">Walmart / big box lot</option>
                                            <option value="rest_area">Highway rest area</option>
                                            <option value="city_stealth">City stealth parking</option>
                                            <option value="scenic_view">
                                                Scenic view / overlook
                                            </option>
                                            <option value="other">Other / misc</option>
                                        </select>
                                    </div>

                                    <div className="form-row">
                                        <label>
                                            <input
                                                type="checkbox"
                                                checked={spotForm.overnightAllowed}
                                                onChange={(e) =>
                                                    setSpotForm((prev) => ({
                                                        ...prev,
                                                        overnightAllowed: e.target.checked,
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
                                                        hasBathroom: e.target.checked,
                                                    }))
                                                }
                                            />{" "}
                                            Bathrooms available
                                        </label>
                                    </div>

                                    <div className="form-group inline">
                                        <div>
                                            <label>Cell signal (0–5)</label>
                                            <input
                                                type="number"
                                                min="0"
                                                max="5"
                                                name="cellSignal"
                                                value={spotForm.cellSignal}
                                                onChange={handleSpotInputChange}
                                            />
                                        </div>
                                        <div>
                                            <label>Safety rating (1–5)</label>
                                            <input
                                                type="number"
                                                min="1"
                                                max="5"
                                                name="safetyRating"
                                                value={spotForm.safetyRating}
                                                onChange={handleSpotInputChange}
                                            />
                                        </div>
                                    </div>

                                    <div className="form-group">
                                        <label>Noise level</label>
                                        <select
                                            name="noiseLevel"
                                            value={spotForm.noiseLevel}
                                            onChange={handleSpotInputChange}
                                        >
                                            <option value="quiet">Quiet</option>
                                            <option value="medium">Medium</option>
                                            <option value="noisy">Noisy</option>
                                            <option value="unknown">Unknown</option>
                                        </select>
                                    </div>

                                    <div className="form-group">
                                        <label>Photo URLs (comma-separated)</label>
                                        <input
                                            type="text"
                                            name="photoUrls"
                                            value={spotForm.photoUrls}
                                            onChange={handleSpotInputChange}
                                            placeholder="https://..., https://..."
                                        />
                                        <p className="tiny-text">
                                            For now, paste image URLs hosted elsewhere. Later we’ll
                                            add direct uploads.
                                        </p>
                                    </div>

                                    {errorMsg && <p className="error-text">{errorMsg}</p>}

                                    <div className="form-actions">
                                        <button
                                            type="button"
                                            className="btn-secondary"
                                            onClick={cancelAdding}
                                            disabled={savingSpot}
                                        >
                                            Cancel
                                        </button>
                                        <button
                                            type="submit"
                                            className="btn-primary"
                                            disabled={savingSpot}
                                        >
                                            {savingSpot ? "Saving…" : "Save Spot"}
                                        </button>
                                    </div>
                                </form>
                            )}
                        </div>
                    )}

                    {/* When viewing a spot / reviews */}
                    {!adding && selectedSpot && (
                        <div className="sheet-section">
                            <h2 className="sheet-title">
                                {getSpotTypeIcon(selectedSpot.spot_type)} {selectedSpot.name}
                            </h2>
                            <p className="sheet-subtitle">{selectedSpot.description}</p>

                            <div className="sheet-meta-row">
                                <span>
                                    {selectedSpotAverageRating
                                        ? `⭐ ${selectedSpotAverageRating.toFixed(1)}`
                                        : "No reviews yet"}
                                </span>
                                <span>
                                    Cell: {selectedSpot.cell_signal ?? 0}/5 · Safety:{" "}
                                    {selectedSpot.safety_rating ?? 0}/5
                                </span>
                            </div>

                            {selectedSpot.photo_urls && selectedSpot.photo_urls.length > 0 && (
                                <div className="photo-strip">
                                    {selectedSpot.photo_urls.slice(0, 4).map((url, idx) => (
                                        <img
                                            key={idx}
                                            src={url}
                                            alt={`${selectedSpot.name} photo ${idx + 1}`}
                                            loading="lazy"
                                        />
                                    ))}
                                </div>
                            )}

                            <div className="reviews-block">
                                <h3 className="reviews-title">Reviews</h3>
                                {selectedSpotReviews.length === 0 && (
                                    <p className="small-text">No reviews yet. Be the first!</p>
                                )}

                                {selectedSpotReviews.slice(0, 6).map((rev) => (
                                    <div key={rev.id} className="review-card">
                                        <div className="review-header">
                                            <span className="review-rating">
                                                {"⭐".repeat(rev.rating || 0)}
                                            </span>
                                            <span className="review-name">
                                                {rev.nickname || "Anon"}
                                            </span>
                                            <span className="review-date">
                                                {rev.created_at
                                                    ? new Date(rev.created_at).toLocaleDateString()
                                                    : ""}
                                            </span>
                                        </div>
                                        <p className="review-comment">{rev.comment}</p>
                                    </div>
                                ))}
                            </div>

                            <form className="review-form" onSubmit={handleAddReview}>
                                <h3 className="reviews-title">Add a Review</h3>

                                <div className="form-group inline">
                                    <div>
                                        <label>Rating (1–5)</label>
                                        <input
                                            type="number"
                                            min="1"
                                            max="5"
                                            name="rating"
                                            value={reviewForm.rating}
                                            onChange={handleReviewInputChange}
                                        />
                                    </div>
                                    <div>
                                        <label>Nickname (optional)</label>
                                        <input
                                            type="text"
                                            name="nickname"
                                            value={reviewForm.nickname}
                                            onChange={handleReviewInputChange}
                                            placeholder="Trail name / alias"
                                        />
                                    </div>
                                </div>

                                <div className="form-group">
                                    <label>Comment</label>
                                    <textarea
                                        name="comment"
                                        value={reviewForm.comment}
                                        onChange={handleReviewInputChange}
                                        placeholder="How was this spot? Safe? Noisy? Clean?"
                                        rows={3}
                                    />
                                </div>

                                {reviewError && (
                                    <p className="error-text">{reviewError}</p>
                                )}

                                <div className="form-actions">
                                    <button
                                        type="submit"
                                        className="btn-primary"
                                        disabled={savingReview}
                                    >
                                        {savingReview ? "Sending…" : "Post Review"}
                                    </button>
                                </div>
                            </form>
                        </div>
                    )}

                    {/* Helpful prompt when nothing is selected */}
                    {!adding && !selectedSpot && (
                        <div className="sheet-section">
                            <h2 className="sheet-title">Explore the map</h2>
                            <p className="small-text">
                                Tap a pin to see details & reviews, or tap{" "}
                                <strong>Add Spot</strong> to share a safe place you&apos;ve
                                stayed.
                            </p>
                        </div>
                    )}
                </aside>
            </div>
        </div>
    );
}

export default App;
