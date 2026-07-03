# Deployment Guide for Tangent Notebooks

This guide covers deploying the web version to GitHub Pages.

## 🌐 Web Deployment (GitHub Pages)

### Initial Setup

1. **Build the application**:
```bash
npm install
npm run build
```

2. **Deploy to GitHub Pages**:
```bash
npm run deploy
```

### Fixing HTTPS Security Warnings

If you see "Potential Security Risk" warnings when visiting `note.tangent.to`, follow these steps:

#### Step 1: Verify GitHub Pages Settings

1. Go to your repository on GitHub: `https://github.com/tangent-to/note`
2. Click **Settings** → **Pages** (in left sidebar)
3. Verify the following:

   - **Source**: Should be `gh-pages` branch, `/ (root)` folder
   - **Custom domain**: Should show `note.tangent.to`
   - **Enforce HTTPS**: ✅ **MUST be checked**

#### Step 2: Check Certificate Status

In the GitHub Pages settings, you should see:

```
✅ DNS check successful
✅ Certificate issued
```

If you see "Certificate pending" or errors:

1. **Remove** the custom domain (clear the field and save)
2. **Wait 1 minute**
3. **Add** the custom domain back (`note.tangent.to`)
4. **Save** and wait for certificate provisioning (can take 10-60 minutes)

#### Step 3: Verify DNS Configuration

Your DNS should point to GitHub Pages:

```
Type: CNAME
Host: note
Value: tangent-to.github.io
```

Or if using A records:
```
Type: A
Host: note
Values:
  185.199.108.153
  185.199.109.153
  185.199.110.153
  185.199.111.153
```

Check DNS propagation:
```bash
dig note.tangent.to
# Should show GitHub Pages IPs or CNAME
```

#### Step 4: Force Fresh Deployment

If issues persist, force a clean deployment:

```bash
# Clean everything
rm -rf dist node_modules/.vite

# Fresh install and build
npm install
npm run build

# Verify CNAME exists in dist
cat dist/CNAME
# Should output: note.tangent.to

# Deploy
npm run deploy
```

#### Step 5: Wait for Propagation

- **DNS changes**: 5-60 minutes
- **HTTPS certificate**: 10-60 minutes
- **Cache clearing**: Try incognito/private browsing

### Common Issues & Solutions

#### Issue: "Not Secure" or "Invalid Certificate"

**Solution**:
1. Ensure "Enforce HTTPS" is checked in GitHub Pages settings
2. Wait for certificate to provision (check status in Pages settings)
3. Try accessing via `https://` explicitly

#### Issue: "404 - File not found"

**Solution**:
1. Check that `gh-pages` branch exists
2. Verify build artifacts are in `dist/`
3. Redeploy: `npm run deploy`

#### Issue: Old version showing

**Solution**:
```bash
# Hard refresh in browser
# Windows/Linux: Ctrl + Shift + R
# Mac: Cmd + Shift + R

# Or clear deployment and redeploy
git push origin --delete gh-pages
npm run deploy
```

### Automated Deployment (CI/CD)

For automatic deployments on push, add this GitHub Action:

`.github/workflows/deploy.yml`:
```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [ main ]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm ci

      - name: Build
        run: npm run build

      - name: Deploy to GitHub Pages
        uses: peaceiris/actions-gh-pages@v3
        with:
          github_token: ${{ secrets.GITHUB_TOKEN }}
          publish_dir: ./dist
          cname: note.tangent.to
```

## 🚀 Quick Deploy Checklist

### Web (GitHub Pages)
- [ ] `npm run build` succeeds
- [ ] `dist/CNAME` contains `note.tangent.to`
- [ ] `npm run deploy` completes
- [ ] GitHub Pages settings show "Enforce HTTPS" ✅
- [ ] Certificate status is "issued" ✅
- [ ] Site accessible at `https://note.tangent.to`

## 📞 Support

If you encounter issues:

1. Check the [GitHub Issues](https://github.com/tangent-to/note/issues)
2. Verify all prerequisites are installed
3. Try a clean build: `rm -rf dist node_modules && npm install && npm run build`

## 🔄 Update Process

To deploy updates:

```bash
# 1. Make your changes
# 2. Test locally
npm run dev

# 3. Build
npm run build

# 4. Deploy web version
npm run deploy
```
