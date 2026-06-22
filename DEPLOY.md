# Deploy Guide (Neon + Render)

Step by step — isko follow karo, 15-20 min me live ho jayega.

## Step 1: Neon database banao

1. https://console.neon.tech pe jao, sign up karo (GitHub se login kar sakti ho, no card needed).
2. "Create a project" — koi bhi naam de do (e.g. `codevector-products`).
3. Project create hone ke baad, dashboard pe **"Connection string"** dikhega. Copy kar lo —
   kuch aisa dikhega:
   ```
   postgresql://username:password@ep-xxxx.us-east-2.aws.neon.tech/neondb?sslmode=require
   ```
4. Isko safe jagah save kar lo, ye tera `DATABASE_URL` hai.

## Step 2: Local pe test karo (recommended, before deploying)

```bash
cd codevector-products
npm install
cp .env.example .env
```

`.env` file kholo aur `DATABASE_URL` me Neon wala connection string paste karo.

```bash
npm run seed
```

Ye 200,000 products generate karega Neon database me (~5-10 sec lagega, internet speed pe depend karta hai).

```bash
npm start
```

Browser me `http://localhost:3000` kholo — products dikhne chahiye. Agar dikh rahe hain, sab sahi hai, ab deploy kar sakti ho.

## Step 3: GitHub pe push karo

```bash
git init
git add .
git commit -m "Initial commit: product catalog with keyset pagination"
git branch -M main
git remote add origin <your-github-repo-url>
git push -u origin main
```

**Important**: `.env` file commit NAHI hogi (already `.gitignore` me hai) — secret connection string GitHub pe nahi jana chahiye.

## Step 4: Render pe deploy karo

1. https://render.com pe jao, sign up karo (GitHub se login, no card needed).
2. Dashboard me **"New +"** → **"Web Service"** click karo.
3. Apna GitHub repo connect karo aur select karo.
4. Settings:
   - **Name**: koi bhi (e.g. `codevector-products`)
   - **Region**: jo nearest ho
   - **Branch**: `main`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Instance Type**: **Free**
5. **"Advanced"** ya **"Environment Variables"** section me jao, add karo:
   - Key: `DATABASE_URL`
   - Value: wahi Neon connection string jo Step 1 me copy kiya tha
6. **"Create Web Service"** click karo.

Render ab build + deploy karega (2-5 min lagega). Done hone pe ek URL milega jaisे:
`https://codevector-products.onrender.com`

Ye URL pe jaake check karo — products dikhne chahiye.

## Step 5: Verify everything works on the live URL

```bash
curl https://your-app.onrender.com/api/health
curl https://your-app.onrender.com/api/products?limit=5
```

Agar JSON response aa raha hai with product data, tu ready hai submission ke liye.

## Common issues

- **"Application failed to respond"**: Render logs check karo (Dashboard → your service → Logs).
  Usually `DATABASE_URL` missing/wrong hota hai.
- **Free tier "spins down"**: Render free web services 15 min inactivity ke baad sleep ho jaate hain,
  pehli request thodi slow (10-30 sec) hogi jab wake up ho rahe honge — ye normal hai, mention kar
  dena submission note me agar interviewer slow load dekhe.
- **Neon connection limit**: Free tier Neon me limited concurrent connections hote hain — agar
  "too many connections" error aaye, `src/db.js` me `max: 10` ko `max: 5` kar dena.

## Submission checklist

- [ ] Live URL test ho gaya (`/api/products` data return kar raha hai)
- [ ] GitHub repo public hai, ya Siddharth (`siddharthshah3030`) ko invite kar diya
- [ ] README.md me apna live URL aur repo URL fill kar diya
- [ ] Email bhej diya `siddharth@codevector.in` ko, with:
  - Live URL
  - GitHub repo link
  - Short note (already README me likha hai, wahi paste/summarize kar sakti ho email me)
