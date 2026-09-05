# 🥗 NutriCal AI — Smart AI Nutrition & Meal Planner

NutriCal AI is a full-stack AI-powered nutrition assistant that generates **personalized diet plans**, **weekly meal planners**, **macro tracking**, and **health insights** using **Gemini AI**.

Built with **Spring Boot + Next.js**, NutriCal AI helps users plan meals, track calories, and improve nutrition intelligently.

---

# 🚀 Features

### 🤖 AI Features
* AI Chat Nutrition Coach
* AI Daily Diet Plan Generator
* AI Weekly Meal Planner
* Smart Macro Distribution
* Personalized Calorie Calculation
* Goal-based diet (weight loss / gain / maintenance)

### 📊 Dashboard
* Daily calories overview
* Macro pie chart
* Nutrition insights
* Weekly tracking
* AI recommendations

### 🥗 Meal Planner
* 7-day weekly plan
* Breakfast / Lunch / Dinner / Snacks
* Measured quantities
* Calories per meal
* Protein / Carbs / Fat per meal

### 📈 Health Tracking
* BMI calculator
* Calories calculator
* Macros calculator
* History tracking
* Saved diet plans

### 🔐 Authentication
* JWT Authentication
* Login / Register
* User-specific history

### ⚡ Performance
* Cached AI responses
* Lazy loaded charts
* Optimized navigation
* Rate-limit protection

---

# 🛠 Tech Stack

### Frontend
* Next.js 14
* TypeScript
* Tailwind CSS
* Recharts
* Axios

### Backend
* Spring Boot 3
* Spring Security
* JWT Authentication
* Spring Data JPA
* MySQL

### AI
* Google Gemini API

---

# 📂 Project Structure

```
NutriCal-AI/
 ├── frontend/     # Next.js frontend
 ├── src/          # Spring Boot backend source
 ├── pom.xml       # Spring Boot backend config (repo root)
 ├── Dockerfile    # Backend container build
 └── README.md
```

---

# ⚙️ Setup Instructions

## 1. Clone Repository

```bash
git clone https://github.com/YashYadav14/NutriCal-AI.git
cd NutriCal-AI
```

---

# Backend Setup

The backend lives at the **repo root** (`pom.xml`, `src/`, `Dockerfile`) — no need to `cd` into a subfolder.

Create `.env` or add to `application.properties`
```
GEMINI_API_KEY=your_key
SPRING_DATASOURCE_URL=jdbc:mysql://localhost:3306/nutrical
SPRING_DATASOURCE_USERNAME=root
SPRING_DATASOURCE_PASSWORD=password
```

Run backend:
```bash
mvn spring-boot:run
```

Backend runs on:
```
http://localhost:8080
```

---

# Frontend Setup

Go to frontend:
```bash
cd frontend
npm install
```

Create `.env.local`
```
NEXT_PUBLIC_API_URL=http://localhost:8080
```

Run frontend:
```bash
npm run dev
```

Frontend runs on:
```
http://localhost:3000
```

---

# 🎯 Example Weekly Plan

```
Monday

Breakfast
Oats with milk (80g + 200ml)
420 kcal
Protein 18g

Lunch
Chicken rice bowl (150g chicken + 150g rice)
620 kcal

Dinner
Grilled fish + vegetables
480 kcal

Snacks
Almonds (30g)
180 kcal
```

---

# 🌍 Deployment

Frontend:
* Vercel

Backend:
* Render

Database:
* MySQL / Railway

Environment variables:
```
NEXT_PUBLIC_API_URL=backend_url
GEMINI_API_KEY=your_key
```

---

# 📸 Screenshots

* Dashboard
* AI Chat
* Weekly Meal Planner
* Nutrition Tracking

---

# 🧠 Future Improvements

* Food image recognition
* Barcode scanning
* Grocery list generator
* Workout integration
* Progress analytics
* Mobile responsive UI

---

# 👨‍💻 Author

Yash Yadav
MCA — Sri Balaji University Pune

---

# ⭐ If you like this project

Give it a star on GitHub ⭐
