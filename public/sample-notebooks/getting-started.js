// ---
// title: Getting started with tangent/ds
// id: ds-getting-started
// ---
// Adapted from tangent-to/ds examples/getting-started.js. Every number in the prose was computed by running these cells on the vega-datasets copy of the Palmer penguins (333 complete cases).

// %% [markdown]
// `@tangent.to/ds` is a data-science toolkit made for JavaScript. It bundles descriptive statistics, hypothesis tests, multivariate analysis, and machine learning behind an API that reads like Python's scikit-learn and R's tidyverse: estimators are objects you `fit` and then `transform` or `predict`, and functional helpers take plain numeric arrays or [Arquero](https://idl.uw.edu/arquero/) data frames. The whole library runs in the browser with no build step and no native dependencies.
//
// The default export is namespaced: `ds.core`, `ds.stats`, `ds.mva`, and `ds.ml`. We will walk one flow end to end on a the penguins dataset: load it, describe it, test a group difference, reduce dimensions with PCA, cluster, fit a linear model, and finish with a supervised classifier. Along the way we use Arquero for the data handling and Observable Plot (preloaded as `Plot`) for the charts.
//
// > This notebook uses tangent/note, a free, open source, portable notebook app that runs in the browser, privately on your hardware. It exports .js files that can be run in the browser, in Node or Deno, compatible with the Zed IDE (which still doesn't render the plots though). **tangent/note is not a cloud service**: your notebook is saved in cache, but save it also on your system: if you clear the cache, you wipe the notebook and data.

// %% [javascript]
import ds from '@tangent.to/ds';
import aq from 'arquero';

// %% [markdown]
// ## Penguins!
//
// We use the Palmer penguins (Horst, Hill & Gorman 2020) data set: 344 penguins of three species measured at Palmer Station, Antarctica, here from the vega-datasets copy on jsDelivr. One bird has `"."` recorded as its sex and ten are unknown; after dropping those we keep 333 complete cases: 146 Adelie, 68 Chinstrap, and 119 Gentoo.

// %% [javascript]
const penguinsSource = await fetch(
  "https://cdn.jsdelivr.net/npm/vega-datasets@2/data/penguins.json"
);
const penguinsDataRaw = await penguinsSource.json();
const penguinsData = penguinsDataRaw // one row has "." instead of null in the Sex field
  .map((row) => (row.Sex === "." ? { ...row, Sex: null } : row))
  .filter((row) => row.Sex);
const penguins = aq.from(penguinsData);
penguins

// %% [javascript]
penguins.groupby("Species").count()

// %% [markdown]
// ## Descriptive statistics
//
// `ds.core.math` provides the numeric primitives: `mean`, `variance` (sample variance by default), `stddev`, quantiles, and more, all taking plain arrays — `penguins.array(column)` hands them straight out of the Arquero table. `ds.stats` adds correlation with an inference layer attached. Body mass averages 4207 g with a standard deviation of 805 g, and flipper length and body mass move together strongly (r = 0.873, with a p-value so small it underflows to 0): bigger flippers, heavier bird.

// %% [javascript]
const math = ds.core.math; // shorter alias
const flipper = penguins.array("Flipper Length (mm)");
const mass = penguins.array("Body Mass (g)");

// pearsonCorrelation returns the coefficient plus a t-test and 95% interval.
const corr = ds.stats.pearsonCorrelation(flipper, mass);

({ // returns a pretty object
  body_mass_g: {
    mean: math.mean(mass),
    stddev: math.stddev(mass),
    min: math.min(mass),
    max: math.max(mass),
  },
  correlation_r: corr.r,
  correlation_p: corr.pValue,
});

// %% [markdown]
// Seeing it helps: each point is a penguin, and the fitted trend line makes the strong flipper-mass relationship visible at a glance. Plot reads the Arquero table directly. The three species occupy different regions: Gentoo (large) sit in the upper right.

// %% [javascript] #wide
Plot.plot({
  width, // builtin: the cell's real output width
  grid: true,
  color: { legend: true },
  marks: [
    Plot.linearRegressionY(penguins, { x: "Flipper Length (mm)", y: "Body Mass (g)", stroke: "#888" }),
    Plot.dot(penguins, { x: "Flipper Length (mm)", y: "Body Mass (g)", stroke: "Species", r: 3 }),
  ],
})

// %% [markdown]
// ## A two-sample t-test
//
// Do Adelie and Gentoo differ in body mass? We filter the table by species,take the mass column from each, and run an independent two-sample t-test (matching scipy's `ttest_ind`). The difference is enormous: Adelie average 3706 g against Gentoo's 5092 g, t = -23.5 on 263 degrees of freedom, with a p-value far below any conventional threshold (it too underflows to 0).

// %% [javascript]
const adelieMass = penguins.filter(d => d.Species === "Adelie").array("Body Mass (g)");
const gentooMass = penguins.filter(d => d.Species === "Gentoo").array("Body Mass (g)");

const tTest = ds.stats.hypothesis.twoSampleTTest(adelieMass, gentooMass);
tTest

// %% [markdown]
// The boxplot with the raw points on top shows why the test is so decisive: Adelie and Gentoo barely overlap in body mass, while Chinstrap sit with Adelie.

// %% [javascript]
Plot.plot({
  width,
  y: { grid: true },
  color: { legend: true },
  marks: [
    Plot.boxY(penguins, { x: "Species", y: "Body Mass (g)", fill: "Species", fillOpacity: 0.25 }),
    Plot.dot(penguins, { x: "Species", y: "Body Mass (g)", fill: "Species", r: 2 }),
  ],
})

// %% [markdown]
// ## Principal component analysis
//
// `ds.mva.PCA` is a fit/transform estimator. The four measurements live on wildly different scales (grams versus millimetres), so we pass `{ scale: true }` to run the PCA on standardized variables -- the same as R's `prcomp(x, scale. = TRUE)`. The first component captures 68.6% of the variance and the first two together 88.1%. `transform` projects the rows onto the components, giving low-dimensional scores to plot.

// %% [javascript]
const measurements = ["Beak Length (mm)", "Beak Depth (mm)", "Flipper Length (mm)", "Body Mass (g)"];
const matrix = penguins.objects().map((d) => measurements.map((c) => d[c]));

const pca = new ds.mva.PCA({ scale: true }).fit(matrix);
const pcaSummary = pca.summary();
const scores = pca.transform(matrix);

({
  varianceExplained: pcaSummary.varianceExplained,
  cumulative: pcaSummary.cumulativeVariance,
});

// %% [markdown]
// `ds.plot.ordiplot` draws the scores on the first two components. Coloured by species, Gentoo separate cleanly along PC1 — overall size, with flipper length (loading 0.96) and body mass (0.91) heaviest on it — while Adelie and Chinstrap split along PC2, which the loading arrows tie to the beak: depth (0.70) and length (0.53).

// %% [javascript]
const speciesLabels = penguins.array("Species");
const pcaResult = {
  scores,
  loadings: pca.getScores("loadings"),
  eigenvalues: pcaSummary.eigenvalues,
  varianceExplained: pcaSummary.varianceExplained,
};
ds.plot.ordiplot(pcaResult, { colorBy: speciesLabels, symbolBy: true }).show(Plot)

// %% [markdown]
// A scree plot of the cumulative variance confirms the numbers above: two components carry most of the structure in the four measurements.

// %% [javascript]
ds.plot.plotScree(pcaResult, { cumulative: true }).show(Plot)

// %% [markdown]
// ## K-means clustering
//
// `ds.ml.KMeans` follows the same object pattern. We cluster the standardized measurements with `k: 3`, never showing the model the species labels. K-means only finds a local optimum, and which one depends on the random start, so we run ten seeded restarts in a for loop and keep the one with the lowest inertia (the within-cluster sum of squares it minimises). We then ask how well the found clusters agree with the true species using the adjusted Rand index (1 = perfect agreement, 0 = chance). One cluster is exactly the 119 Gentoo; the other two split the Adelie-Chinstrap mass, so the agreement is strong but not perfect (ARI = 0.80).

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
// Colouring the penguins by the cluster k-means assigned (it never saw the species) shows the same three clouds as the PCA plot. `assign` bolts the cluster labels onto the table as a new column.

// %% [javascript]
const clustered = penguins.assign(aq.table({
  cluster: kmeans.labels.map((l) => `cluster ${l}`),
}));
Plot.plot({
  width,
  grid: true,
  color: { legend: true },
  marks: [
    Plot.dot(clustered, { x: "Flipper Length (mm)", y: "Beak Length (mm)", fill: "cluster", r: 3 }),
  ],
})

// %% [markdown]
// ## A linear model with GLM
//
// With the Gaussian family, `ds.stats.GLM` is ordinary least squares, what we expect when we think of a *linear regression*. We regress body mass on flipper length and read the coefficients: each extra millimetre of flipper predicts about 50 g more body mass (intercept -5872.1, slope 50.15 — the values `lm` reports in R on the same 333 birds). The `coefficients` array is ordered intercept first, then one slope per feature.

// %% [javascript]
const glm = new ds.stats.GLM({ family: "gaussian" })
  .fit(flipper.map((v) => [v]), mass);
glm

// %% [markdown]
// Overlaying the fitted line closes the loop: the OLS fit tracks the cloud, so body mass rises steadily with flipper length. A straight line only needs its two endpoints.

// %% [javascript]
const [f0, f1] = d3.extent(flipper);
const glmLine = [f0, f1].map((f) => ({
  "Flipper Length (mm)": f,
  fitted: glm.coefficients[0] + glm.coefficients[1] * f,
}));
Plot.plot({
  width,
  grid: true,
  y: { label: "Body Mass (g)" },
  marks: [
    Plot.dot(penguins, { x: "Flipper Length (mm)", y: "Body Mass (g)", fill: "steelblue", r: 3 }),
    Plot.line(glmLine, { x: "Flipper Length (mm)", y: "fitted", stroke: "crimson", strokeWidth: 2 }),
  ],
})

// %% [markdown]
// ## Machine learning: predicting the species
//
// Finally, supervised learning. Can the four measurements identify the species? `ds.ml.validation.trainTestSplit` holds out 20% of the rows (seeded, so the notebook is reproducible), `ds.ml.RandomForestClassifier` fits 100 trees on the remaining 266, and `ds.ml.metrics` scores the 67 held-out predictions. The measurements are highly informative: accuracy on this test set is 0.985 — a single mislabelled bird -- and Cohen's kappa (chance-corrected agreement, which accounts for the unequal class sizes) is 0.976.

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
// The confusion matrix shows where the mistakes live: the diagonal counts correct predictions per species, and off-diagonal cells are confusions.

// %% [javascript]
ds.plot.plotConfusionMatrix(split.yTest, predicted, { width: 420, height: 380 }).show(Plot)

// %% [markdown]
// Random forests also report how much each feature contributed to the split decisions. Flipper length (0.41) and beak length (0.39) carry almost all of it, roughly tied at the top; beak length is what separates Adelie from
// Chinstrap, the pair the size-driven features cannot tell apart. Body mass adds almost nothing (0.06) once the others are in -- the same story the PCA loadings told above.

// %% [javascript]
const importances = forest.featureImportances
  .map((importance, j) => ({ feature: measurements[j], importance }))
  .sort((a, b) => b.importance - a.importance);

ds.plot.plotFeatureImportance(importances, { width: 560, height: 260 }).show(Plot)

// %% [markdown]
// ## Where to go next
//
// The same fit/predict pattern extends across the library: `ds.ml` has gradient boosting, k-nearest neighbours, GAMs, DBSCAN and hierarchical clustering, imputers, and cross-validation; `ds.stats` has ANOVA, Tukey HSD, nonparametric tests, and model comparison; `ds.mva` adds LDA, CCA, and RDA. Each has a matching notebook in the ds repository's examples folder.
