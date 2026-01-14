import { getCategoryDisplayName } from "../api";
import type { RiskLevel } from "../api";
import "./FiltersBar.css";

interface FiltersBarProps {
  categories: string[];
  selectedCategory: string;
  setSelectedCategory: (category: string) => void;
  selectedRisk: string;
  setSelectedRisk: (risk: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

export function FiltersBar({
  categories,
  selectedCategory,
  setSelectedCategory,
  selectedRisk,
  setSelectedRisk,
  searchQuery,
  setSearchQuery,
}: FiltersBarProps) {
  const risks: (RiskLevel | "all")[] = ["all", "low", "medium", "high"];

  return (
    <div className="filters-bar">
      <div className="filter-group">
        <label htmlFor="category-filter">Category:</label>
        <select
          id="category-filter"
          value={selectedCategory}
          onChange={(e) => setSelectedCategory(e.target.value)}
        >
          <option value="all">All Categories</option>
          {categories.map((cat) => (
            <option key={cat} value={cat}>
              {getCategoryDisplayName(cat)}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-group">
        <label htmlFor="risk-filter">Risk:</label>
        <select
          id="risk-filter"
          value={selectedRisk}
          onChange={(e) => setSelectedRisk(e.target.value)}
        >
          {risks.map((risk) => (
            <option key={risk} value={risk}>
              {risk === "all" ? "All Risks" : risk.charAt(0).toUpperCase() + risk.slice(1)}
            </option>
          ))}
        </select>
      </div>

      <div className="filter-group search-group">
        <label htmlFor="search-filter">Search:</label>
        <input
          id="search-filter"
          type="text"
          placeholder="Search paths or reasons..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>
    </div>
  );
}
