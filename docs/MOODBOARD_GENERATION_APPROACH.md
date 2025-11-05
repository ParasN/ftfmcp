# Moodboard Generation - New Approach

## Overview

The moodboard generation has been redesigned to integrate seamlessly with the existing query flow. Instead of treating moodboards as a separate workflow, we now feed the RA (Range Architecture) input JSON to the LLM, which processes it like any other query with additional steps.

## How It Works

### 1. Trigger Keyword Detection

When the user sends a message containing the keyword **`GENERATE_MOODBOARD`**, the system activates moodboard generation mode.

Example:
```
GENERATE_MOODBOARD
```

### 2. RA Input JSON Loading

The system loads the mock RA input from `backend/config/mock_ra_input.json`, which contains:

```json
{
  "request_type": "moodboard",
  "brand": "Nike",
  "cohort": "Athletic Performance",
  "attributes": {
    "colors": ["Black", "White", "Red", "Orange", "Volt"],
    "patterns": ["Geometric", "Minimal", "Digital", "Abstract"],
    "materials": ["Mesh", "Recycled Synthetics", "Flyknit", "Dri-Fit"],
    "silhouettes": ["Lightweight Trainer", "Compression Top", "Windbreaker", "Track Pant"]
  },
  "bricks": ["Athletic Footwear", "Running Apparel", "Athletic Accessories"],
  "categories": ["Footwear", "Athletic Tops", "Athletic Bottoms", "Accessories"],
  "lifecycle_stages": ["Growth", "Emerging", "Maturity"],
  "price_position": "Premium",
  "time_period": {
    "start_date": "2024-01-01",
    "end_date": "2024-12-31"
  }
}
```

### 3. Attribute Combination Generation

The system breaks down the RA input into **attribute combinations** (essentially forming trends):

Each combination includes:
- **Colors**: 2 colors from the palette
- **Pattern**: One pattern type
- **Material**: One material type
- **Silhouette**: One silhouette type
- **Bricks**: Product categories
- **Lifecycle**: Target lifecycle stage

Example combinations:
```
Combination 1:
- Colors: Black, White
- Pattern: Geometric
- Material: Mesh
- Silhouette: Lightweight Trainer
- Bricks: Athletic Footwear
- Lifecycle: Growth

Combination 2:
- Colors: White, Red
- Pattern: Minimal
- Material: Recycled Synthetics
- Silhouette: Compression Top
- Bricks: Running Apparel
- Lifecycle: Emerging
```

### 4. BigQuery Query Instructions

The LLM receives detailed instructions to:

1. **Query BigQuery Tables**: Use the available BigQuery tools to find trends matching each attribute combination
2. **Build SQL Queries**: Create queries that:
   - Filter by colors, patterns, materials, and silhouettes
   - Join multiple tables if needed
   - Filter by bricks/categories
   - Filter by lifecycle stages
   - Order by trend scores/momentum
   - Limit to top 1-2 trends per combination

3. **Extract Key Information**:
   - Trend Name
   - Lifecycle Stage
   - Momentum
   - Trend Score
   - "Why It Fits" narrative
   - Visual URL

4. **Generate Output**: Return a markdown table:
```markdown
| Trend Name | Lifecycle | Momentum | Score | Why It Fits | Visual |
|------------|-----------|----------|-------|-------------|--------|
| Neo-Kinetic Mesh | Growth | Rising | 84 | Combines geometric patterns with mesh materials... | [url] |
```

## Flow Diagram

```
User Message with "GENERATE_MOODBOARD"
           ↓
Load RA Input JSON (mock_ra_input.json)
           ↓
Generate Attribute Combinations
           ↓
Build Query Instructions for LLM
           ↓
Feed to LLM (same flow as regular queries)
           ↓
LLM uses BigQuery tools to query data
           ↓
LLM generates moodboard markdown table
           ↓
Return response to user
```

## Key Benefits

1. **Unified Flow**: Moodboards use the same query routing and LLM processing as other queries
2. **Data-Driven**: Results come from actual BigQuery data, not mock fixtures
3. **Flexible**: Attribute combinations can be customized by modifying the RA input JSON
4. **Traceable**: Each trend recommendation is backed by data from BQ tables
5. **Extensible**: Easy to add more attribute types or combination logic

## Implementation Files

- **`backend/config/mock_ra_input.json`**: Mock RA input with attributes
- **`backend/src/agent.js`**: 
  - `loadRaInput()`: Loads the RA input JSON
  - `generateAttributeCombinations()`: Creates attribute combinations
  - `buildMoodboardQueryInstructions()`: Generates LLM instructions
  - `prepareMoodboardContext()`: Prepares the moodboard context for the chat

## Usage

To trigger moodboard generation, simply send:
```
GENERATE_MOODBOARD
```

The system will:
1. Load the RA input
2. Generate attribute combinations
3. Query BigQuery for matching trends
4. Return a formatted moodboard table
5. Generate and attach a PDF — the system now provides both a markdown preview of the moodboard and a downloadable PDF attachment.

## Future Enhancements

1. **Dynamic RA Input**: ✅ Now supports parsing RA input from messages
2. **Multiple Approaches**: Support different scoring approaches (cohort-based, social-fusion, attribute-fingerprint)
3. **Visual Generation**: Integrate with image generation APIs to create visuals
4. **Enhanced PDF Styling**: Improve PDF layout with custom fonts and styling
5. **Combination Strategies**: Support different strategies for generating attribute combinations
6. **Real-time Preview**: Stream the moodboard generation progress to the frontend
2. **Multiple Approaches**: Support different scoring approaches (cohort-based, social-fusion, attribute-fingerprint)
3. **Visual Generation**: Integrate with image generation APIs to create visuals
4. **Enhanced PDF Styling**: Improve PDF layout with custom fonts and styling
5. **Combination Strategies**: Support different strategies for generating attribute combinations
6. **Real-time Preview**: Stream the moodboard generation progress to the frontend
3. **Visual Generation**: Integrate with image generation APIs to create visuals
4. **PDF Export**: Convert the moodboard table to a styled PDF document
5. **Combination Strategies**: Support different strategies for generating attribute combinations
