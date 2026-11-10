// Branch-based GitHub Pages serves site/ from the repository root.
// This bridge provides the same SDK as the self-hosted dist/ build.
// The dist/ build replaces this bridge with a complete copy of src/stake.js.
export * from '../src/stake.js';
