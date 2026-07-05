# Tangent Notebook File Format

## Overview

Tangent Notebook uses a **text-based format** inspired by Jupytext, making notebooks easy to read, edit, and version control with Git.

## File Extension

Notebooks are saved with a `.js` extension to leverage syntax highlighting in most editors.

## Format Structure

### Header (Optional)

```javascript
// ---
// title: My Notebook
// id: notebook-unique-id
// ---
```

The header contains metadata:
- `title`: Human-readable notebook name
- `id`: Unique identifier for the notebook

### Cell Delimiters

Cells are separated using special comment markers:

#### Code Cells

```javascript
// %% [javascript]

const x = 42;
console.log(x);
```

#### Markdown Cells

```javascript
// %% [markdown]
/*
# My Heading

This is markdown content.
You can use **bold**, *italic*, and `code`.

## Lists

- Item 1
- Item 2
- Item 3
*/
```

### Cell Tags

The delimiter can carry tags after the cell type:

#### `#hide` — collapsed cells

```javascript
// %% [javascript] #hide
// setup code that would clutter the page
const config = { retries: 3 };
```

A cell tagged `#hide` still runs normally but renders collapsed in the UI
(only its first line is shown; click to expand). Collapsing or expanding a
cell in the UI updates the tag on export, so the state round-trips through
the file. Unknown tags are ignored.

Because tags live inside a line comment after the `// %%` prefix, files
using them remain plain JavaScript and stay compatible with editors that
detect percent-format cells (e.g. Zed's REPL, which matches the `// %%`
prefix and ignores the rest of the line).

## Example Notebook

```javascript
// ---
// title: Data Analysis Example
// id: notebook-12345
// ---

// %% [markdown]
/*
# Data Analysis

This notebook demonstrates data analysis with JavaScript.
*/

// %% [javascript]

// Import libraries
import * as d3 from 'd3';

// Load data
const data = [1, 2, 3, 4, 5];
console.log('Data loaded:', data);

// %% [javascript]

// Calculate statistics
const sum = data.reduce((a, b) => a + b, 0);
const average = sum / data.length;

({ sum, average })

// %% [markdown]
/*
## Results

The analysis shows interesting patterns in the data.
*/
```

## Advantages

### Git-Friendly
- **No timestamps**: The format excludes execution timestamps, reducing git diff noise
- **Human-readable**: Easy to review changes in pull requests
- **Mergeable**: Conflicts are easier to resolve than with JSON

### Simple
- **Plain text**: Can be edited in any text editor
- **Clear structure**: Cell boundaries are obvious
- **Syntax highlighting**: Works with JavaScript syntax highlighters

### Compatible
- **Import/Export**: Notebooks can be imported and exported in this format
- **Version control**: Track changes over time effectively
- **Collaboration**: Team members can work on notebooks using standard git workflows

## Working with the Format

### Creating a New Notebook

1. Click "New" in the menu
2. Add cells and edit content
3. Click "Save" to save in localStorage
4. Click "Export" > "JavaScript (.js)" to download as a file

### Importing a Notebook

1. Click "Import" in the menu
2. Select a `.js` notebook file
3. The notebook will be parsed and loaded

### Editing Manually

You can edit notebook files directly in a text editor:

1. Open the `.js` file
2. Edit cell content between delimiters
3. Save the file
4. Import back into Tangent Notebook

## Comparison with JSON Format

### Text Format (.js)
```javascript
// %% [javascript]
const x = 42;
```
