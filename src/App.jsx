import { useEffect, useState } from "react";
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

const initialForm = {
    name: "",
    description: "",
    overnightAllowed: false,
    hasBathroom: false,
    cellSignal: 3,
    noiseLevel: "quiet",
    safetyRating: 4,
    spotType: "forest_road",
};

function App() {
    const [spots, setSpots] = useState([]);
    const [adding, setAdding] = useState(false);
    const [pendingLocation, setPendingLocation] = useState(null);
    const [form, setForm] = useState(initialForm);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [status, setStatus] = useState("Connecting to Supabase…");
    const [errorMsg, setErrorMsg] = useState("");
    const [darkMode, setDarkMode] = useState(false);

    const center = [39.5, -98.35]; // Center of US

    // Load existing spots from Supabase on first render
    useEffect(() => {
        async function loadSpots() {
            setStatus("Loading spots from Supabase…");

            const { data, error } = await supabase
                .from("spots")
                .select("*")
                .order("id", { ascending: true });

            if (error) {
                console.error("Error loading spots:", error);
                setStatus("Error loading spots: " + error.message);
                alert("Error loading spots: " + error.message);
            } else {
                console.log("Loaded spots from Supabase:", data);
                setSpots(data || []);
                setStatus(`Connected to Supabase. Spots loaded: ${data?.length || 0}`);
            }

            setLoading(false);
        }

        loadSpots();
    }, []);

    function startAdding() {
        setAdding(true);
        setPendingLocation(null);
        setForm(initialForm);
        setErrorMsg("");
    }

    function cancelAdding() {
        setAdding(false);
        setPendingLocation(null);
        setForm(initialForm);
        setErrorMsg("");
    }

    function handleMapClick(lat, lng) {
        if (!adding) return;
        setPendingLocation({ lat, lng });
        setErrorMsg("");
    }

    function handleInputChange(e) {
        const { name, value } = e.target;
        setForm((prev) => ({
            ...prev,
            [name]: value,
        }));
    }

    async function handleSubmit(e) {
        e.preventDefault();
        setErrorMsg("");

        if (!adding) {
            setErrorMsg("Click 'Add Spot' first.");
            return;
        }

        if (!pendingLocation) {
            setErrorMsg("Click on the map to choose a location.");
            return;
        }

        if (!form.name.trim()) {
            setErrorMsg("Name is required.");
            return;
        }

        const { lat, lng } = pendingLocation;
        const cell_signal = clamp(parseInt(form.cellSignal, 10) || 0, 0, 5);
        const safety_rating = clamp(
            parseInt(form.safetyRating, 10) || 0,
            0,
            5
        );
        const noise_level = form.noiseLevel || "unknown";
        const spot_type = form.spotType || "other";

        setSaving(true);

        const { data, error } = await supabase
            .from("spots")
            .insert({
                name: form.name.trim(),
                description: form.description.trim(),
                lat,
                lng,
                overnight_allowed: form.overnightAllowed,
                has_bathroom: form.hasBathroom,
                cell_signal,
                noise_level,
                safety_rating,
                spot_type,
            })
            .select()
            .single();

        setSaving(false);

        if (error) {
            console.error("Error saving spot:", error);
            setErrorMsg("Failed to save spot: " + error.message);
            return;
        }

        setSpots((prev) => [...prev, data]);
        cancelAdding();
    }

    const appClassName = darkMode ? "app dark" : "app";

    return (
        <div className={appClassName}>
            <header className="app-header">
                <div className="brand-row">
                    <div>
                        <h1>Nomad Safe Spots</h1>
                        <p className="subtitle">
                            Community-driven safe parking map – free, no paywalls.
                        </p>
                        <p className="brand-by">
                            Built with ❤️ by <span className="brand-name">Statusnone</span>
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

                <button className="btn-primary" onClick={startAdding}>
                    ➕ Add Spot
                </button>

                {loading && <p className="small-text">Loading spots…</p>}
            </header>

            <div className="main-content">
                <div className="map-wrapper">
                    <MapContainer center={center} zoom={4} scrollWheelZoom className="map">
                        <TileLayer
                            attribution="&copy; OpenStreetMap contributors"
                            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                        />

                        <AddSpotOnClick active={adding} onMapClick={handleMapClick} />

                        {spots.map((spot) => (
                            <Marker key={spot.id} position={[spot.lat, spot.lng]}>
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
                                            {(
                                                spot.spot_type || "other"
                                            )
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
                                        <div>Cell signal: {spot.cell_signal ?? 0} / 5 bars</div>
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

                <aside className="sidebar">
                    <h2 className="sidebar-title">Add a New Spot</h2>

                    {!adding && (
                        <p className="small-text">
                            Click <strong>Add Spot</strong>, then click the map to choose a
                            location.
                        </p>
                    )}

                    {adding && !pendingLocation && (
                        <p className="small-text highlight">
                            Step 1: Click on the map to pick a location.
                        </p>
                    )}

                    {adding && pendingLocation && (
                        <>
                            <p className="small-text">
                                Location selected:
                                <br />
                                Lat: {pendingLocation.lat.toFixed(4)}, Lng:{" "}
                                {pendingLocation.lng.toFixed(4)}
                            </p>

                            <form className="spot-form" onSubmit={handleSubmit}>
                                <div className="form-group">
                                    <label>Name *</label>
                                    <input
                                        type="text"
                                        name="name"
                                        value={form.name}
                                        onChange={handleInputChange}
                                        placeholder="E.g. Quiet forest pull-off"
                                        required
                                    />
                                </div>

                                <div className="form-group">
                                    <label>Description</label>
                                    <textarea
                                        name="description"
                                        value={form.description}
                                        onChange={handleInputChange}
                                        placeholder="What should people know about this spot?"
                                        rows={3}
                                    />
                                </div>

                                <div className="form-group">
                                    <label>Spot type</label>
                                    <select
                                        name="spotType"
                                        value={form.spotType}
                                        onChange={handleInputChange}
                                    >
                                        <option value="forest_road">Forest road / BLM</option>
                                        <option value="campground">Campground</option>
                                        <option value="walmart">Walmart / big box lot</option>
                                        <option value="rest_area">Highway rest area</option>
                                        <option value="city_stealth">City stealth parking</option>
                                        <option value="scenic_view">Scenic view / overlook</option>
                                        <option value="other">Other / misc</option>
                                    </select>
                                </div>

                                <div className="form-row">
                                    <label>
                                        <input
                                            type="checkbox"
                                            checked={form.overnightAllowed}
                                            onChange={(e) =>
                                                setForm((prev) => ({
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
                                            checked={form.hasBathroom}
                                            onChange={(e) =>
                                                setForm((prev) => ({
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
                                            value={form.cellSignal}
                                            onChange={handleInputChange}
                                        />
                                    </div>
                                    <div>
                                        <label>Safety rating (1–5)</label>
                                        <input
                                            type="number"
                                            min="1"
                                            max="5"
                                            name="safetyRating"
                                            value={form.safetyRating}
                                            onChange={handleInputChange}
                                        />
                                    </div>
                                </div>

                                <div className="form-group">
                                    <label>Noise level</label>
                                    <select
                                        name="noiseLevel"
                                        value={form.noiseLevel}
                                        onChange={handleInputChange}
                                    >
                                        <option value="quiet">Quiet</option>
                                        <option value="medium">Medium</option>
                                        <option value="noisy">Noisy</option>
                                        <option value="unknown">Unknown</option>
                                    </select>
                                </div>

                                {errorMsg && <p className="error-text">{errorMsg}</p>}

                                <div className="form-actions">
                                    <button
                                        type="button"
                                        className="btn-secondary"
                                        onClick={cancelAdding}
                                        disabled={saving}
                                    >
                                        Cancel
                                    </button>
                                    <button
                                        type="submit"
                                        className="btn-primary"
                                        disabled={saving}
                                    >
                                        {saving ? "Saving…" : "Save Spot"}
                                    </button>
                                </div>
                            </form>
                        </>
                    )}
                </aside>
            </div>
        </div>
    );
}

export default App;
