# 🚨 Fix: Certificate Not Issued for note.tangent.to

## Current Issue

GitHub Pages says:
```
Enforce HTTPS — Unavailable for your site because a certificate
has not yet been issued for your domain (note.tangent.to)
```

This means GitHub can't provision a Let's Encrypt certificate. Let's fix it!

---

## ✅ Step-by-Step Fix

### Step 1: Check Your DNS Configuration

You need **ONE** of these DNS configurations (not both):

#### Option A: CNAME Record (Recommended)

In your DNS provider (wherever tangent.to is registered):

```
Type:  CNAME
Name:  notebook
Value: tangent-to.github.io.
TTL:   3600 (or Auto)
```

**Important**:
- Name should be `note` (not `note.tangent.to`)
- Value should end with a dot `.` or not, depending on your DNS provider
- Remove any conflicting A records for `note`

#### Option B: A Records (Alternative)

If CNAME doesn't work, use these A records:

```
Type:  A
Name:  notebook
Value: 185.199.108.153
TTL:   3600

Type:  A
Name:  notebook
Value: 185.199.109.153
TTL:   3600

Type:  A
Name:  notebook
Value: 185.199.110.153
TTL:   3600

Type:  A
Name:  notebook
Value: 185.199.111.153
TTL:   3600
```

**Plus an AAAA record** (for IPv6):
```
Type:  AAAA
Name:  notebook
Value: 2606:50c0:8000::153
TTL:   3600

Type:  AAAA
Name:  notebook
Value: 2606:50c0:8001::153
TTL:   3600

Type:  AAAA
Name:  notebook
Value: 2606:50c0:8002::153
TTL:   3600

Type:  AAAA
Name:  notebook
Value: 2606:50c0:8003::153
TTL:   3600
```

### Step 2: Verify DNS is Working

**In your terminal**, run:

```bash
# Check DNS resolution
dig note.tangent.to

# For CNAME (Option A), you should see:
# note.tangent.to. 3600 IN CNAME tangent-to.github.io.

# For A records (Option B), you should see:
# note.tangent.to. 3600 IN A 185.199.108.153
# (and the other IPs)
```

**If DNS isn't showing correctly**:
- Wait 5-15 minutes for propagation
- Check you saved the DNS changes
- Verify you're editing the correct domain

### Step 3: Remove Custom Domain in GitHub

1. Go to: https://github.com/tangent-to/note/settings/pages

2. Under "Custom domain":
   - **Delete** `note.tangent.to` (clear the field completely)
   - Click **Save**

3. **Wait 1-2 minutes**

### Step 4: Re-add Custom Domain

1. Still in GitHub Pages settings:
   - Type `note.tangent.to` in the Custom domain field
   - Click **Save**

2. You should see:
   ```
   ⏳ DNS check in progress...
   ```

3. **Wait 2-5 minutes**, then refresh the page

### Step 5: Check Certificate Status

After refreshing the GitHub Pages settings page, you should see:

**✅ Success**:
```
✅ DNS check successful
⏳ Certificate provisioning in progress...
```

Or even better:
```
✅ DNS check successful
✅ Certificate issued
☑️ Enforce HTTPS (checkbox is now available)
```

**❌ Still failing?**
```
❌ DNS check failed
   Both www.note.tangent.to and note.tangent.to are
   improperly configured
```

If you see the error, **your DNS is wrong** - go back to Step 1.

### Step 6: Enable HTTPS

Once you see "Certificate issued":

1. ✅ Check **"Enforce HTTPS"**
2. Click **Save**
3. Wait 2-5 minutes

### Step 7: Test Your Site

```bash
# Test HTTPS
curl -I https://note.tangent.to

# Should show:
# HTTP/2 200
# server: GitHub.com
```

Open in browser (incognito mode):
- https://note.tangent.to
- Should load with green padlock 🔒

---

## ⏱️ Expected Timeline

| Step | Time |
|------|------|
| DNS propagation | 5-60 minutes |
| GitHub DNS check | 2-5 minutes |
| Certificate provisioning | 10-30 minutes |
| HTTPS enforcement | 2-5 minutes |
| **Total** | **20-100 minutes** |

**Tip**: Use https://dnschecker.org to see if DNS has propagated globally!

---

## 🔧 Common Issues

### Issue: "DNS check failed"

**Cause**: DNS not configured correctly

**Fix**:
1. Double-check DNS records in your DNS provider
2. Make sure you're editing `note` subdomain
3. Use Option A (CNAME) if possible - it's simpler
4. Wait 15 minutes and try again

### Issue: "Certificate provisioning takes forever"

**Cause**: DNS propagation delay or GitHub queue

**Fix**:
1. Verify DNS with `dig note.tangent.to`
2. Remove and re-add domain to reset process
3. Wait up to 1 hour - it can be slow
4. Check https://www.githubstatus.com/ for GitHub issues

### Issue: "Works on http:// but not https://"

**Cause**: Certificate issued but HTTPS not enforced

**Fix**:
1. Go to GitHub Pages settings
2. Check "Enforce HTTPS"
3. Wait 5 minutes
4. Test in incognito mode

---

## 🆘 Still Not Working?

### Debug Checklist

Run these commands and share the output:

```bash
# 1. Check DNS
dig note.tangent.to

# 2. Check DNS globally
curl "https://dns.google/resolve?name=note.tangent.to&type=A"

# 3. Check current HTTP response
curl -I http://note.tangent.to

# 4. Check HTTPS (will fail but shows the error)
curl -I https://note.tangent.to

# 5. Check if gh-pages branch exists
git ls-remote --heads origin gh-pages
```

### What Your DNS Provider Needs

Send this to your DNS provider's support:

```
I need to configure a CNAME record for my GitHub Pages site:

Host/Name:  note
Type:       CNAME
Value:      tangent-to.github.io.
TTL:        3600 (or automatic)

This should point note.tangent.to to tangent-to.github.io
for my GitHub Pages site.
```

---

## 🎯 Quick Summary

1. **Configure DNS**: CNAME `note` → `tangent-to.github.io`
2. **Wait for DNS**: 5-15 minutes
3. **Remove domain** in GitHub settings
4. **Re-add domain** in GitHub settings
5. **Wait for certificate**: 10-30 minutes
6. **Enable HTTPS** when available
7. **Test**: https://note.tangent.to

---

## 📞 Need More Help?

- Check DNS propagation: https://dnschecker.org
- GitHub Pages docs: https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site
- DNS provider support: Check their documentation for CNAME records

**Most common fix**: Just configure CNAME correctly and wait 30 minutes! 🎉
