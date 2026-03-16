import { getCategoryDisplayName } from "../api";
import "./FiltersBar.css";

interface FiltersBarProps {
  categories: string[];
  selectedCategory: string;
  setSelectedCategory: (category: string) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

export function FiltersBar({
  categories,
  selectedCategory,
  setSelectedCategory,
  searchQuery,
  setSearchQuery,
}: FiltersBarProps) {
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
