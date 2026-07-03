# 🔒 Quick Fix: HTTPS Security Warning

If you're seeing **"Potential Security Risk Ahead"** when visiting `note.tangent.to`, follow these steps:

## ✅ Immediate Fix (5 minutes)

### Step 1: GitHub Pages Settings

1. Go to: https://github.com/tangent-to/tangent-notebook/settings/pages

2. Check these settings:
   ```
   Source: gh-pages branch, / (root) folder
   Custom domain: note.tangent.to
   ✅ Enforce HTTPS (MUST BE CHECKED)
   ```

3. Look for certificate status below the custom domain field:
   - ✅ **Good**: "DNS check successful" + "Certificate issued"
   - ❌ **Problem**: "Certificate pending" or any errors

### Step 2: If Certificate is Pending

1. **Remove custom domain**:
   - Delete `note.tangent.to` from the field
   - Click **Save**

2. **Wait 1 minute**

3. **Add it back**:
   - Type `note.tangent.to` again
   - Click **Save**

4. **Wait 10-30 minutes** for Let's Encrypt certificate to provision

### Step 3: Force Fresh Deployment

Run this from your project directory:

```bash
# Build latest version
npm run build

# Deploy (will build automatically)
npm run deploy

# OR force clean deploy
npm run deploy:clean
```

### Step 4: Verify

1. **Check DNS** (in terminal):
   ```bash
   dig note.tangent.to
   # Should show GitHub Pages IPs or CNAME to tangent-to.github.io
   ```

2. **Test in browser**:
   - Clear browser cache or use **Incognito/Private mode**
   - Visit: https://note.tangent.to
   - Should load without security warnings

## 🔍 Root Causes

The security warning happens when:

1. ❌ **"Enforce HTTPS" is not enabled** → Enable in GitHub Pages settings
2. ❌ **Certificate not provisioned** → Wait or re-add custom domain
3. ❌ **DNS misconfigured** → Verify DNS points to GitHub Pages
4. ❌ **CNAME file missing** → Should be in `dist/` folder after build

## 🛠️ Detailed Troubleshooting

### Check 1: Is CNAME file deployed?

```bash
# Check if CNAME exists in your build
cat dist/CNAME
# Should output: note.tangent.to

# Check on GitHub Pages
curl https://tangent-to.github.io/tangent-notebook/CNAME
# Should output: note.tangent.to
```

### Check 2: DNS Configuration

Your DNS should have:

**Option A: CNAME Record (Recommended)**
```
Type: CNAME
Name: notebook
Value: tangent-to.github.io
TTL: 3600
```

**Option B: A Records**
```
Type: A
Name: notebook
Values:
  185.199.108.153
  185.199.109.153
  185.199.110.153
  185.199.111.153
TTL: 3600
```

### Check 3: GitHub Pages Status

Visit: https://github.com/tangent-to/tangent-notebook/settings/pages

Look for these indicators:

✅ **Healthy**:
```
Your site is live at https://note.tangent.to
✅ DNS check successful
✅ HTTPS enforced - certificate issued
```

❌ **Needs fixing**:
```
⚠️ DNS check pending
⚠️ Certificate pending
⚠️ Not yet available
```

### Check 4: Browser Issues

Sometimes it's just browser cache:

1. **Hard refresh**:
   - Windows/Linux: `Ctrl + Shift + R`
   - Mac: `Cmd + Shift + R`

2. **Clear browsing data**:
   - Chrome: Settings → Privacy → Clear browsing data
   - Firefox: Settings → Privacy → Clear Data

3. **Try different browser** or **Incognito mode**

## ⚡ Nuclear Option (Last Resort)

If nothing works, completely reset GitHub Pages:

```bash
# 1. Delete gh-pages branch remotely
git push origin --delete gh-pages

# 2. Build and deploy fresh
npm run build
npm run deploy

# 3. In GitHub settings, remove custom domain and save
# 4. Wait 2 minutes
# 5. Add custom domain back and enable HTTPS
# 6. Wait 15-30 minutes for certificate
```

## 📞 Still Having Issues?

### Check Current Status

```bash
# DNS propagation
dig note.tangent.to

# SSL certificate
openssl s_client -connect note.tangent.to:443 -servername note.tangent.to

# HTTP vs HTTPS
curl -I http://note.tangent.to
curl -I https://note.tangent.to
```

### Get Help

1. Check if GitHub Pages is down: https://www.githubstatus.com/
2. Review GitHub Pages docs: https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site
3. Open an issue: https://github.com/tangent-to/tangent-notebook/issues

## ⏱️ How Long to Wait?

- **DNS propagation**: 5-60 minutes (usually ~10 min)
- **HTTPS certificate**: 10-60 minutes (usually ~15 min)
- **GitHub Pages build**: 2-5 minutes

**Tip**: Use incognito mode to test - it avoids browser cache issues!

## ✨ Expected Result

Once fixed, you should see:

```
✅ https://note.tangent.to loads
✅ Green padlock in browser
✅ No security warnings
✅ Latest version of your app
```

---

**Quick command to deploy latest version right now:**

```bash
npm run deploy
```

Then wait 2-5 minutes and try: https://note.tangent.to
