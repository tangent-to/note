// ---
// title: Getting started with tangent/ds
// id: ds-getting-started
// ---
// Adapted from tangent-to/ds examples/getting-started.js for tangent/note:
// the penguins CSV ships as a local asset, charts size to the `width`
// builtin, and one cell demonstrates the #wide output tag. Keep the
// analysis in sync with the ds original.

// %% [markdown]
/*
`@tangent.to/ds` is a browser-first data-science toolkit. It bundles
descriptive statistics, hypothesis tests, multivariate analysis, and machine
learning behind an API that reads like scikit-learn and R: estimators are
objects you `fit` and then `transform` or `predict`, and functional helpers
take plain numeric arrays. The whole library runs in the browser with no
build step and no native dependencies.

The default export is namespaced: `ds.core`, `ds.stats`, `ds.mva`, and
`ds.ml`. We will walk one flow end to end on a real dataset: load it,
describe it, test a group difference, reduce dimensions with PCA,
cluster, fit a linear model, and finish with a supervised classifier.
*/

// %% [javascript]

// Bare specifier: tangent/note resolves it from jsDelivr's +esm build.
// (import ds from 'https://esm.sh/@tangent.to/ds' works too.)
import ds from '@tangent.to/ds';

const math = ds.core.math;

// A quick sanity check that the namespaces are present.
({
  core: Object.keys(ds.core),
  stats_has_GLM: typeof ds.stats.GLM,
  mva_has_PCA: typeof ds.mva.PCA,
  ml_has_RandomForest: typeof ds.ml.RandomForestClassifier,
});

// %% [markdown]
/*
## A real dataset

We use the Palmer penguins (Horst, Hill & Gorman 2020): 344 penguins of
three species measured at Palmer Station, Antarctica. The CSV ships with
this notebook (originally from the palmerpenguins repository) and is parsed
with `d3.csvParse` (`d3` is preloaded in tangent notebooks). Eleven rows are
missing at least one measurement; we keep the 342 complete cases for the
four numeric columns and get 151 Adelie, 68 Chinstrap, and 123 Gentoo.
*/

// %% [javascript]

// Bundled with the app; original source:
// github.com/allisonhorst/palmerpenguins/main/inst/extdata/penguins.csv
const csvText = await (await fetch('/sample-notebooks/penguins.csv')).text();

const measurements = ['bill_length_mm', 'bill_depth_mm', 'flipper_length_mm', 'body_mass_g'];
const penguins = d3
  .csvParse(csvText, d3.autoType)
  .filter((row) => measurements.every((c) => typeof row[c] === 'number'));

const countBySpecies = {};
for (const row of penguins) {
  countBySpecies[row.species] = (countBySpecies[row.species] ?? 0) + 1;
}

({
  rows: penguins.length,
  columns: penguins.columns,
  by_species: countBySpecies,
  first_row: penguins[0],
});

// %% [markdown]
/*
## Descriptive statistics

`ds.core.math` provides the numeric primitives: `mean`, `variance` (sample
variance by default), `stddev`, quantiles, and more. `ds.stats` adds
correlation with an inference layer attached. Body mass averages about
4202 g with a standard deviation of about 802 g, and flipper length and
body mass move together strongly (r = 0.871, with a p-value so small it
underflows to 0): bigger flippers, heavier bird.
*/

// %% [javascript]

const flipper = penguins.map((p) => p.flipper_length_mm);
const mass = penguins.map((p) => p.body_mass_g);

const massStats = {
  mean: math.mean(mass),
  stddev: math.stddev(mass),
  min: math.min(mass),
  max: math.max(mass),
};

// pearsonCorrelation returns the coefficient plus a t-test and 95% interval.
const corr = ds.stats.pearsonCorrelation(flipper, mass);

({
  body_mass_g: massStats,
  correlation_r: corr.r,
  correlation_p: corr.pValue,
});

// %% [markdown]
/*
Seeing it helps: each point is a penguin, and the fitted trend line makes
the strong flipper-mass relationship visible at a glance. The three species
occupy different regions of the plot: Gentoo (large) sit in the upper right.
*/

// %% [javascript] #wide

const plot_corr = Plot.plot({
  width, // builtin: the cell's real output width
  grid: true,
  x: { label: 'Flipper length (mm)' },
  y: { label: 'Body mass (g)' },
  color: { legend: true },
  marks: [
    Plot.linearRegressionY(penguins, { x: 'flipper_length_mm', y: 'body_mass_g', stroke: '#888' }),
    Plot.dot(penguins, { x: 'flipper_length_mm', y: 'body_mass_g', stroke: 'species', r: 3 }),
  ],
});
plot_corr;

// %% [markdown]
/*
## A two-sample t-test

Do Adelie and Gentoo differ in body mass? We split the column by species and
run an independent two-sample t-test (matching scipy's `ttest_ind`). The
helper returns the t statistic, the p-value, degrees of freedom, and both
group means. The difference is enormous: Adelie average about 3701 g against
Gentoo's 5076 g, t = -23.6 on 272 degrees of freedom, with p far below any
conventional threshold (it too underflows to 0).
*/

// %% [javascript]

const adelieMass = penguins
  .filter((p) => p.species === 'Adelie')
  .map((p) => p.body_mass_g);

const gentooMass = penguins
  .filter((p) => p.species === 'Gentoo')
  .map((p) => p.body_mass_g);

const tTest = ds.stats.hypothesis.twoSampleTTest(adelieMass, gentooMass);

({
  statistic: tTest.statistic,
  pValue: tTest.pValue,
  df: tTest.df,
  mean_adelie: tTest.mean1,
  mean_gentoo: tTest.mean2,
});

// %% [markdown]
/*
The boxplot with the raw points on top shows why the test is so decisive:
Adelie and Gentoo barely overlap in body mass, while Chinstrap sit with
Adelie.
*/

// %% [javascript]

const plot_ttest = Plot.plot({
  width,
  x: { label: 'Species' },
  y: { label: 'Body mass (g)', grid: true },
  color: { legend: true },
  marks: [
    Plot.boxY(penguins, { x: 'species', y: 'body_mass_g', fill: 'species', fillOpacity: 0.25 }),
    Plot.dot(penguins, { x: 'species', y: 'body_mass_g', fill: 'species', r: 2 }),
  ],
});
plot_ttest;

// %% [markdown]
/*
## Principal component analysis

`ds.mva.PCA` is a fit/transform estimator. The four measurements live on
wildly different scales (grams versus millimetres), so we pass
`{ scale: true }` to run the PCA on standardized variables — the same as
R's `prcomp(x, scale. = TRUE)`. The first component captures about 69% of
the variance and the first two together about 88%. `transform` projects the
rows onto the components, giving low-dimensional scores to plot.
*/

// %% [javascript]

const matrix = penguins.map((p) => measurements.map((c) => p[c]));

const pca = new ds.mva.PCA({ scale: true }).fit(matrix);
const pcaSummary = pca.summary();
const scores = pca.transform(matrix);

({
  varianceExplained: pcaSummary.varianceExplained,
  cumulative: pcaSummary.cumulativeVariance,
  first_two_scores: scores.slice(0, 2),
});

// %% [markdown]
/*
`ds.plot.ordiplot` draws the scores on the first two components. Coloured by
species, Gentoo separate cleanly along PC1 (overall size: flipper length and
body mass load most heavily on it), while Adelie and Chinstrap split along
PC2, which the loading arrows tie to the two bill measurements.
*/

// %% [javascript]

const speciesLabels = penguins.map((p) => p.species);
const pcaResult = {
  scores,
  loadings: pca.getScores('loadings'),
  eigenvalues: pcaSummary.eigenvalues,
  varianceExplained: pcaSummary.varianceExplained,
};
const plot_pcaOrdi = ds.plot
  .ordiplot(pcaResult, { colorBy: speciesLabels, symbolBy: true })
  .show(Plot);
plot_pcaOrdi;

// %% [markdown]
/*
A scree plot of the cumulative variance confirms the numbers above: two
components carry most of the structure in the four measurements.
*/

// %% [javascript]

const plot_pcaScree = ds.plot.plotScree(pcaResult, { cumulative: true }).show(Plot);
plot_pcaScree;

// %% [markdown]
/*
## K-means clustering

`ds.ml.KMeans` follows the same object pattern. We cluster the standardized
measurements with `k: 3`, never showing the model the species labels. K-means
only finds a local optimum, and which one depends on the random start, so we
run ten seeded restarts and keep the one with the lowest inertia (the
within-cluster sum of squares it minimises). We then ask how well the found
clusters agree with the true species using the adjusted Rand index (1 =
perfect agreement, 0 = chance). Gentoo are recovered perfectly; Adelie and
Chinstrap overlap in size, so the agreement is strong but not perfect
(ARI about 0.79).
*/

// %% [javascript]

const colMeans = measurements.map((c, j) => math.mean(matrix.map((row) => row[j])));
const colSds = measurements.map((c, j) => math.stddev(matrix.map((row) => row[j])));
const standardized = matrix.map((row) => row.map((v, j) => (v - colMeans[j]) / colSds[j]));

let kmeans = null;
for (let seed = 1; seed <= 10; seed++) {
  const candidate = new ds.ml.KMeans({ k: 3, seed }).fit(standardized);
  if (!kmeans || candidate.inertia < kmeans.inertia) kmeans = candidate;
}
const ari = ds.ml.metrics.adjustedRandIndex(speciesLabels, kmeans.labels);

({
  cluster_sizes: [0, 1, 2].map((k) => kmeans.labels.filter((l) => l === k).length),
  inertia: kmeans.inertia,
  adjusted_rand_index: ari,
});

// %% [markdown]
/*
Colouring the penguins by the cluster k-means assigned (it never saw the
species) shows the same three clouds as the PCA plot: one cluster is
essentially the Gentoo, and the other two split the Adelie-Chinstrap mass.
*/

// %% [javascript]

const clusterPoints = penguins.map((p, i) => ({
  flipper_length_mm: p.flipper_length_mm,
  bill_length_mm: p.bill_length_mm,
  cluster: `cluster ${kmeans.labels[i]}`,
}));
const plot_kmeans = Plot.plot({
  width,
  grid: true,
  x: { label: 'Flipper length (mm)' },
  y: { label: 'Bill length (mm)' },
  color: { legend: true },
  marks: [
    Plot.dot(clusterPoints, { x: 'flipper_length_mm', y: 'bill_length_mm', fill: 'cluster', r: 3 }),
  ],
});
plot_kmeans;

// %% [markdown]
/*
## A linear model with the GLM

With the Gaussian family, `ds.stats.GLM` is ordinary least squares. We
regress body mass on flipper length and read the coefficients: each extra
millimetre of flipper predicts about 50 g more body mass (the same
intercept -5780.8 and slope 49.7 R's `lm` reports on this data). The
`coefficients` array is ordered intercept first, then one slope per feature.
*/

// %% [javascript]

const glm = new ds.stats.GLM({ family: 'gaussian' })
  .fit(penguins.map((p) => [p.flipper_length_mm]), mass);

({
  intercept: glm.coefficients[0],
  slope_flipper: glm.coefficients[1],
});

// %% [markdown]
/*
Overlaying the fitted line on the data closes the loop: the OLS fit tracks
the cloud, so body mass rises steadily with flipper length.
*/

// %% [javascript]

const glmLine = penguins
  .map((p) => ({
    flipper_length_mm: p.flipper_length_mm,
    fitted: glm.coefficients[0] + glm.coefficients[1] * p.flipper_length_mm,
  }))
  .sort((a, b) => a.flipper_length_mm - b.flipper_length_mm);
const plot_glm = Plot.plot({
  width,
  grid: true,
  x: { label: 'Flipper length (mm)' },
  y: { label: 'Body mass (g)' },
  marks: [
    Plot.dot(penguins, { x: 'flipper_length_mm', y: 'body_mass_g', fill: 'steelblue', r: 3 }),
    Plot.line(glmLine, { x: 'flipper_length_mm', y: 'fitted', stroke: 'crimson', strokeWidth: 2 }),
  ],
});
plot_glm;

// %% [markdown]
/*
## Machine learning: predicting the species

Finally, supervised learning. Can the four measurements identify the
species? `ds.ml.validation.trainTestSplit` holds out 20% of the rows
(seeded, so the notebook is reproducible), `ds.ml.RandomForestClassifier`
fits 100 trees on the rest, and `ds.ml.metrics` scores the held-out
predictions. The measurements are highly informative: accuracy on this test
set is about 0.97, and Cohen's kappa (chance-corrected agreement, which
accounts for the unequal class sizes) is about 0.95.
*/

// %% [javascript]

const split = ds.ml.validation.trainTestSplit(matrix, speciesLabels, {
  ratio: 0.8,
  seed: 42,
});

const forest = new ds.ml.RandomForestClassifier({ nEstimators: 100, seed: 42 })
  .fit(split.XTrain, split.yTrain);

const predicted = forest.predict(split.XTest);

({
  train_rows: split.XTrain.length,
  test_rows: split.XTest.length,
  accuracy: ds.ml.metrics.accuracy(split.yTest, predicted),
  cohen_kappa: ds.ml.metrics.cohenKappa(split.yTest, predicted),
});

// %% [markdown]
/*
The confusion matrix shows where the few mistakes (if any) live: the
diagonal counts correct predictions per species, and off-diagonal cells are
confusions, which occur between Adelie and Chinstrap when they occur at all.
*/

// %% [javascript]

const plot_confusion = ds.plot
  .plotConfusionMatrix(split.yTest, predicted, { width: 420, height: 380 })
  .show(Plot);
plot_confusion;

// %% [markdown]
/*
Random forests also report how much each feature contributed to the split
decisions. Flipper length and bill length carry almost all of it, roughly
tied at the top; bill length is what separates Adelie from Chinstrap, the
pair the size-driven features cannot tell apart. Body mass adds almost
nothing once the others are in — the same story the PCA loadings told above.
*/

// %% [javascript]

const importances = forest.featureImportances
  .map((importance, j) => ({ feature: measurements[j], importance }))
  .sort((a, b) => b.importance - a.importance);

const plot_importance = ds.plot
  .plotFeatureImportance(importances, { width: 560, height: 260 })
  .show(Plot);
plot_importance;

// %% [markdown]
/*
## Where to go next

The same fit/predict pattern extends across the library: `ds.ml` has
gradient boosting, k-nearest neighbours, GAMs, DBSCAN and hierarchical
clustering, imputers, and cross-validation; `ds.stats` has ANOVA, Tukey HSD,
nonparametric tests, and model comparison; `ds.mva` adds LDA, CCA, and RDA.
Each has a matching notebook in the ds repository's examples folder.

This notebook also uses tangent/note itself: every chart sizes to the
built-in `width`, and the first scatter breaks out of the reading column
via the `#wide` cell tag (see the cell menu for `Wide output`,
`Collapse cell`, `Skip cell`, and friends — each round-trips through the
exported `.js` file as a tag on the cell delimiter).
*/
