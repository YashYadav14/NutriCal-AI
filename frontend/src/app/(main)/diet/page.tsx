"use client";

import React, { useState } from "react";
import {
  AiRequest, AiDietResponse, generateDietPlan, generateWeeklyDietPlan,
  calculateBmi, calculateCalories, calculateMacros
} from "@/lib/api";
import { Card, CardHeader, CardContent } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, ArrowLeft, Zap, Sparkles, MoveRight, CheckCircle2 } from "lucide-react";
import Link from "next/link";

// Canonical display order for meals. Chosen deliberately (snack sits between
// lunch and dinner, matching how people actually eat through the day) rather
// than relying on whatever key order the API/AI happens to return — that
// order isn't guaranteed and shouldn't drive the UI's numbering.
const MEAL_ORDER = ['breakfast', 'lunch', 'snacks', 'dinner'] as const;

function orderedMealEntries(mealPlan: Record<string, any> | undefined | null): [string, any][] {
  if (!mealPlan) return [];
  return MEAL_ORDER
    .filter((key) => key in mealPlan)
    .map((key) => [key, mealPlan[key]] as [string, any]);
}

export default function DietGenerator() {
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<AiDietResponse | null>(null);
  const [error, setError] = useState("");
  const [viewMode, setViewMode] = useState<'daily'|'weekly'>('daily');
  const [selectedDay, setSelectedDay] = useState<string>('monday');
  const [weeklyLoading, setWeeklyLoading] = useState(false);
  const [weeklyError, setWeeklyError] = useState("");

  const [formData, setFormData] = useState<AiRequest>({
    weight: 70,
    height: 175,
    age: 28,
    gender: "Male",
    activityLevel: "Moderate",
    goal: "Maintain weight",
    dietaryPreferences: "None",
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({
      ...prev,
      [name]: name === "weight" || name === "height" || name === "age" ? Number(value) : value,
    }));
  };

  React.useEffect(() => {
    const cached = localStorage.getItem("cachedDietPlan");
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        setResponse(parsed);
        if (parsed.weekly_plan) setViewMode("weekly");
      } catch (err) {}
    }
  }, []);

  // ── Enum mappers for backend ────────────────────────────────────────────
  // Backend expects uppercase enums; form values are human-readable strings.
  const mapSex = (gender: string): string =>
    gender.toUpperCase() === "FEMALE" ? "FEMALE" : "MALE";

  const mapActivityLevel = (level: string): string => {
    const map: Record<string, string> = {
      "Sedentary": "SEDENTARY",
      "Lightly Active": "LIGHT",
      "Moderate": "MODERATE",
      "Very Active": "ACTIVE",
    };
    return map[level] ?? "MODERATE";
  };

  const mapGoal = (goal: string): string => {
    const map: Record<string, string> = {
      "Lose weight": "CUT",
      "Maintain weight": "MAINTAIN",
      "Build muscle": "BULK",
    };
    return map[goal] ?? "MAINTAIN";
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError("");
    setResponse(null);

    try {
      const data = await generateDietPlan(formData);

      if (!data || (data as any).success === false) {
        throw new Error((data as any)?.message || "Failed to generate your plan. Please try again.");
      }

      setResponse(data);
      localStorage.setItem("cachedDietPlan", JSON.stringify(data));
      // Daily plan only for now — weekly is generated separately, on demand,
      // when the user actually switches to the Weekly Plan tab.
      setViewMode('daily');

      // 2. Persist biometric calculations to backend — powers dashboard history charts.
      console.log("Calling BMI, Calories, Macros APIs", {
        weight: formData.weight,
        height: formData.height,
        gender: formData.gender,
        activityLevel: formData.activityLevel,
        goal: formData.goal,
        calories: data?.calories || 2000,
      });

      await Promise.all([
        calculateBmi({
          weightKg: formData.weight,
          heightCm: formData.height,
        }),
        calculateCalories({
          sex: mapSex(formData.gender),
          age: formData.age,
          weightKg: formData.weight,
          heightCm: formData.height,
          activityLevel: mapActivityLevel(formData.activityLevel),
          goal: mapGoal(formData.goal),
        }),
        calculateMacros({
          calories: data?.calories || 2000,
          proteinPercent: 30,
          fatPercent: 25,
          carbPercent: 45,
        }),
      ]).catch((err) => {
        console.error("Save APIs failed:", err?.response?.data ?? err?.message ?? err);
      });
    } catch (err: unknown) {
      console.error(err);
      const errorMessage = err && typeof err === 'object' && 'response' in err && err.response && typeof err.response === 'object' && 'data' in err.response && err.response.data && typeof err.response.data === 'object' && 'error' in err.response.data ? String((err.response.data as Record<string, unknown>).error) : "Failed to generate plan. Please try again.";
      setError(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  const handleShowWeekly = async () => {
    setViewMode('weekly');
    if (response?.weekly_plan || weeklyLoading) return; // already have it, or already fetching

    setWeeklyLoading(true);
    setWeeklyError("");
    try {
      const weekly = await generateWeeklyDietPlan(formData);
      if (!weekly || (weekly as any).success === false || !weekly.weekly_plan) {
        throw new Error((weekly as any)?.message || "Failed to generate your weekly plan. Please try again.");
      }
      setResponse((prev) => {
        if (!prev) return prev;
        const merged = { ...prev, weekly_plan: weekly.weekly_plan };
        // Persist immediately so a reload (or a session bounce) doesn't throw away
        // work that already finished generating.
        try {
          localStorage.setItem("cachedDietPlan", JSON.stringify(merged));
        } catch (err) {
          console.error("Failed to cache weekly plan:", err);
        }
        return merged;
      });
      setSelectedDay('monday');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to generate your weekly plan. Please try again.";
      setWeeklyError(msg);
    } finally {
      setWeeklyLoading(false);
    }
  };

  const calculatePercentage = (value: number, totalCalories: number, type: 'pro'|'carb'|'fat') => {
    // 1g Protein = 4kcal, 1g Carb = 4kcal, 1g Fat = 9kcal
    const calMultiplier = type === 'fat' ? 9 : 4;
    return Math.min(Math.round(((value * calMultiplier) / totalCalories) * 100), 100);
  };

  return (
    <div className="min-h-screen bg-[#FDFDFD] text-gray-900 font-sans py-12 px-6 sm:px-12 selection:bg-black selection:text-white">
      <div className="max-w-[1000px] mx-auto">
        
        <Link href="/" className="inline-flex items-center gap-2 text-gray-400 hover:text-black font-semibold tracking-wide text-sm mb-12 transition-colors">
          <ArrowLeft size={16} strokeWidth={2.5} /> DASHBOARD
        </Link>
        
        {/* Header Section */}
        <motion.div 
           initial={{ opacity: 0, scale: 0.95 }}
           animate={{ opacity: 1, scale: 1 }}
           transition={{ duration: 0.8, ease: "easeOut" }}
           className="mb-16 text-center"
        >
          <div className="mx-auto bg-black text-white w-20 h-20 rounded-[1.5rem] flex items-center justify-center mb-8 shadow-[0_10px_40px_rgba(0,0,0,0.15)] relative overflow-hidden group">
            <div className="absolute inset-0 bg-gradient-to-tr from-white/20 to-transparent opacity-0 group-hover:opacity-100 transition-opacity"></div>
            <Sparkles size={36} strokeWidth={1.5} />
          </div>
          <h1 className="text-5xl md:text-6xl font-extrabold text-black tracking-tighter">AI Meal Planner</h1>
          <p className="text-xl text-gray-500 mt-6 font-medium max-w-2xl mx-auto leading-relaxed">Let Gemini build your hyper-personalized, macro-matched nutritional protocol generated instantly.</p>
        </motion.div>

        <AnimatePresence mode="wait">
          {!response && !loading && (
            <motion.div 
               key="form"
               initial={{ opacity: 0, y: 20 }}
               animate={{ opacity: 1, y: 0 }}
               exit={{ opacity: 0, y: -20, filter: "blur(10px)" }}
               transition={{ duration: 0.5, ease: [0.25, 1, 0.5, 1] }}
            >
              <Card className="max-w-3xl mx-auto p-2" delay={0.2}>
                <CardHeader title="Your Biometrics" description="Provide your baseline so our AI can calculate the perfect macro ratio." className="pb-4 border-none" />
                <CardContent>
                  <form onSubmit={handleSubmit} className="space-y-8">
                    
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-8">
                      <div className="space-y-3">
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-widest pl-1">Age</label>
                        <input type="number" name="age" value={formData.age} onChange={handleChange} required className="w-full text-lg font-medium rounded-2xl px-5 py-4 bg-gray-50/50 border border-gray-100 focus:bg-white focus:border-black focus:ring-1 focus:ring-black focus:outline-none transition-all" />
                      </div>
                      <div className="space-y-3">
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-widest pl-1">Gender</label>
                        <select name="gender" value={formData.gender} onChange={handleChange} className="w-full text-lg font-medium rounded-2xl px-5 py-4 bg-gray-50/50 border border-gray-100 focus:bg-white focus:border-black focus:ring-1 focus:ring-black focus:outline-none transition-all appearance-none cursor-pointer">
                          <option value="Male">Male</option>
                          <option value="Female">Female</option>
                          <option value="Other">Other</option>
                        </select>
                      </div>
                      <div className="space-y-3">
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-widest pl-1">Weight (kg)</label>
                        <input type="number" name="weight" value={formData.weight} onChange={handleChange} required className="w-full text-lg font-medium rounded-2xl px-5 py-4 bg-gray-50/50 border border-gray-100 focus:bg-white focus:border-black focus:ring-1 focus:ring-black focus:outline-none transition-all" />
                      </div>
                      <div className="space-y-3">
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-widest pl-1">Height (cm)</label>
                        <input type="number" name="height" value={formData.height} onChange={handleChange} required className="w-full text-lg font-medium rounded-2xl px-5 py-4 bg-gray-50/50 border border-gray-100 focus:bg-white focus:border-black focus:ring-1 focus:ring-black focus:outline-none transition-all" />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-8 pt-4 border-t border-gray-50/50">
                      <div className="space-y-3">
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-widest pl-1">Activity Level</label>
                        <select name="activityLevel" value={formData.activityLevel} onChange={handleChange} className="w-full text-lg font-medium rounded-2xl px-5 py-4 bg-gray-50/50 border border-gray-100 focus:bg-white focus:border-black focus:ring-1 focus:ring-black focus:outline-none transition-all appearance-none cursor-pointer">
                          <option value="Sedentary">Sedentary (Office, little exercise)</option>
                          <option value="Lightly Active">Lightly Active (1-3 days/wk)</option>
                          <option value="Moderate">Moderate (3-5 days/wk)</option>
                          <option value="Very Active">Very Active (Heavy 6-7 days/wk)</option>
                        </select>
                      </div>

                      <div className="space-y-3">
                        <label className="text-xs font-bold text-gray-400 uppercase tracking-widest pl-1">Primary Goal</label>
                        <select name="goal" value={formData.goal} onChange={handleChange} className="w-full text-lg font-medium rounded-2xl px-5 py-4 bg-gray-50/50 border border-gray-100 focus:bg-white focus:border-black focus:ring-1 focus:ring-black focus:outline-none transition-all appearance-none cursor-pointer">
                          <option value="Lose weight">Caloric Deficit (Lose fat)</option>
                          <option value="Maintain weight">Maintenance (Stay steady)</option>
                          <option value="Build muscle">Caloric Surplus (Build muscle)</option>
                        </select>
                      </div>
                    </div>

                    <div className="space-y-3 pt-4">
                      <label className="text-xs font-bold text-gray-400 uppercase tracking-widest pl-1 flex justify-between">
                         Dietary Preferences <span className="text-gray-300 font-medium normal-case">Optional</span>
                      </label>
                      <input type="text" name="dietaryPreferences" value={formData.dietaryPreferences} onChange={handleChange} placeholder="e.g. Vegan, Keto, Lactose Intolerant, No Nuts..." className="w-full text-lg font-medium rounded-2xl px-5 py-4 bg-gray-50/50 border border-gray-100 focus:bg-white focus:border-black focus:ring-1 focus:ring-black focus:outline-none transition-all" />
                    </div>

                    {error && (
                      <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="p-5 bg-red-50 text-red-600 rounded-2xl text-sm font-semibold flex items-start gap-3 border border-red-100">
                        <CheckCircle2 className="shrink-0 mt-0.5" size={18} /> {error}
                      </motion.div>
                    )}

                    <div className="pt-6">
                      <Button type="submit" disabled={loading} className="w-full group py-5 text-lg">
                         Generate Protocol <MoveRight className="ml-2 group-hover:translate-x-1 transition-transform" size={20} />
                      </Button>
                    </div>
                  </form>
                </CardContent>
              </Card>
            </motion.div>
          )}

          {loading && (
            <motion.div 
               key="loading"
               initial={{ opacity: 0, scale: 0.95 }}
               animate={{ opacity: 1, scale: 1 }}
               exit={{ opacity: 0, filter: "blur(10px)" }}
               className="max-w-3xl mx-auto text-center py-20"
            >
               {/* Premium Loading Skeleton */}
               <div className="flex flex-col items-center justify-center space-y-8">
                 <Loader2 className="animate-spin text-black" size={48} strokeWidth={1.5} />
                 
                 <div className="space-y-2">
                   <h3 className="text-2xl font-bold tracking-tight">Synthesizing Protocol...</h3>
                   <p className="text-gray-500 font-medium">Gemini 1.5 Pro is calculating your precise macro targets.</p>
                 </div>

                 <div className="w-full max-w-sm mt-12 space-y-4">
                   <div className="h-4 bg-gray-100 rounded-full w-full overflow-hidden relative">
                     <motion.div 
                        initial={{ x: "-100%" }}
                        animate={{ x: "100%" }}
                        transition={{ repeat: Infinity, duration: 1.5, ease: "linear" }}
                        className="absolute inset-0 bg-gradient-to-r from-transparent via-gray-200 to-transparent w-full"
                     />
                   </div>
                   <div className="h-4 bg-gray-100 rounded-full w-3/4 mx-auto overflow-hidden relative">
                       <motion.div 
                        initial={{ x: "-100%" }}
                        animate={{ x: "100%" }}
                        transition={{ repeat: Infinity, duration: 1.5, ease: "linear", delay: 0.2 }}
                        className="absolute inset-0 bg-gradient-to-r from-transparent via-gray-200 to-transparent w-full"
                     />
                   </div>
                 </div>
               </div>
            </motion.div>
          )}

          {response && !loading && (
            <motion.div 
               key="results"
               initial={{ opacity: 0, y: 30 }}
               animate={{ opacity: 1, y: 0 }}
               transition={{ duration: 0.7, ease: [0.25, 1, 0.5, 1], staggerChildren: 0.1 }}
               className="space-y-8"
            >
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
                
                {/* Calories Highlight Card */}
                <motion.div className="lg:col-span-4" initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: 1, scale: 1 }}>
                  <div className="bg-black text-white h-full p-10 rounded-[2.5rem] shadow-[0_20px_40px_rgba(0,0,0,0.15)] flex flex-col justify-between relative overflow-hidden group">
                     <div className="absolute -right-8 -top-8 bg-white/5 w-40 h-40 rounded-full blur-2xl group-hover:bg-white/10 transition-colors duration-1000"></div>
                     <div>
                       <div className="bg-white/10 w-12 h-12 rounded-2xl flex items-center justify-center mb-6 backdrop-blur-md border border-white/10">
                         <Zap className="text-yellow-400" size={24} fill="currentColor" />
                       </div>
                       <h2 className="text-lg font-bold text-gray-300 tracking-wide">DAILY CALORIES</h2>
                     </div>
                     <div className="mt-8">
                       <p className="text-6xl font-black tracking-tighter">
                         {viewMode === 'weekly' && response?.weekly_plan 
                           ? (response.weekly_plan[selectedDay]?.calories ?? response?.calories ?? 0)
                           : (response?.calories ?? 0)}
                       </p>
                       <p className="text-xl font-medium text-gray-400 mt-2 tracking-wide">KCAL / DAY</p>
                     </div>
                  </div>
                </motion.div>

                {/* Macro Progress Bars */}
                {(!response?.weekly_plan || viewMode === 'daily') && (
                <motion.div className="lg:col-span-8" initial={{ opacity: 0, x: 20 }} animate={{ opacity: 1, x: 0 }}>
                  <Card className="h-full border-none shadow-[0_10px_40px_rgb(0,0,0,0.04)]">
                    <CardHeader title="Macronutrient Split" description="Targeted distribution for your body composition." className="border-none pb-2 xl:pt-10" />
                    <CardContent className="space-y-8">
                       {/* Protein */}
                       <div>
                         <div className="flex justify-between items-end mb-3">
                           <h3 className="font-bold tracking-wide uppercase text-sm flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-blue-500"></div> Protein</h3>
                           <span className="text-2xl font-black">{response?.macros?.protein ?? 0}g <span className="text-sm text-gray-400 font-medium tracking-wide">({calculatePercentage(response?.macros?.protein ?? 0, response?.calories ?? 1, 'pro')}%)</span></span>
                         </div>
                         <div className="h-4 bg-gray-100 rounded-full overflow-hidden">
                           <motion.div initial={{ width: 0 }} animate={{ width: `${calculatePercentage(response?.macros?.protein ?? 0, response?.calories ?? 1, 'pro')}%` }} transition={{ duration: 1, delay: 0.2 }} className="h-full bg-blue-500 rounded-full shadow-[inset_0_-2px_4px_rgba(0,0,0,0.1)]"/>
                         </div>
                       </div>
                       
                       {/* Carbs */}
                       <div>
                         <div className="flex justify-between items-end mb-3">
                           <h3 className="font-bold tracking-wide uppercase text-sm flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-orange-500"></div> Carbohydrates</h3>
                           <span className="text-2xl font-black">{response?.macros?.carbs ?? 0}g <span className="text-sm text-gray-400 font-medium tracking-wide">({calculatePercentage(response?.macros?.carbs ?? 0, response?.calories ?? 1, 'carb')}%)</span></span>
                         </div>
                         <div className="h-4 bg-gray-100 rounded-full overflow-hidden">
                           <motion.div initial={{ width: 0 }} animate={{ width: `${calculatePercentage(response?.macros?.carbs ?? 0, response?.calories ?? 1, 'carb')}%` }} transition={{ duration: 1, delay: 0.4 }} className="h-full bg-orange-500 rounded-full shadow-[inset_0_-2px_4px_rgba(0,0,0,0.1)]"/>
                         </div>
                       </div>

                       {/* Fats */}
                       <div>
                         <div className="flex justify-between items-end mb-3">
                           <h3 className="font-bold tracking-wide uppercase text-sm flex items-center gap-2"><div className="w-2 h-2 rounded-full bg-emerald-500"></div> Dietary Fats</h3>
                           <span className="text-2xl font-black">{response?.macros?.fats ?? 0}g <span className="text-sm text-gray-400 font-medium tracking-wide">({calculatePercentage(response?.macros?.fats ?? 0, response?.calories ?? 1, 'fat')}%)</span></span>
                         </div>
                         <div className="h-4 bg-gray-100 rounded-full overflow-hidden">
                           <motion.div initial={{ width: 0 }} animate={{ width: `${calculatePercentage(response?.macros?.fats ?? 0, response?.calories ?? 1, 'fat')}%` }} transition={{ duration: 1, delay: 0.6 }} className="h-full bg-emerald-500 rounded-full shadow-[inset_0_-2px_4px_rgba(0,0,0,0.1)]"/>
                         </div>
                       </div>
                    </CardContent>
                  </Card>
                </motion.div>
                )}
              </div>

              {/* Meal Plan Grid Layout */}
              <div className="mt-12">
                <div className="flex items-center gap-4 mb-4 px-4">
                  <div className="h-px bg-gray-200 flex-grow"></div>
                  <h2 className="text-2xl font-extrabold tracking-tight uppercase text-gray-400">The Protocol</h2>
                  <div className="h-px bg-gray-200 flex-grow"></div>
                </div>

                {/* View Toggles */}
                <div className="flex justify-center mb-8">
                  <div className="bg-gray-100 p-1 rounded-full inline-flex">
                    <button 
                      onClick={() => setViewMode('daily')}
                      className={`px-6 py-2.5 rounded-full text-sm font-bold transition-all ${viewMode === 'daily' ? 'bg-white text-black shadow-[0_2px_10px_rgb(0,0,0,0.05)]' : 'text-gray-500 hover:text-black'}`}
                    >
                      Daily Plan
                    </button>
                    <button 
                      onClick={handleShowWeekly}
                      className={`px-6 py-2.5 rounded-full text-sm font-bold transition-all ${viewMode === 'weekly' ? 'bg-white text-black shadow-[0_2px_10px_rgb(0,0,0,0.05)]' : 'text-gray-500 hover:text-black'}`}
                    >
                      Weekly Plan
                    </button>
                  </div>
                </div>

                <AnimatePresence mode="wait">
                  {viewMode === 'daily' ? (
                    <motion.div 
                      key="daily"
                      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                      className="grid grid-cols-1 md:grid-cols-2 gap-6"
                    >
                      {orderedMealEntries(response?.meal_plan).map(([meal, item], i) => (
                        <div key={meal} className="bg-white p-8 rounded-[2rem] border border-gray-100 shadow-[0_4px_20px_rgb(0,0,0,0.02)] hover:shadow-[0_8px_30px_rgb(0,0,0,0.06)] transition-all group">
                          <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                            <span className="w-6 h-6 rounded-full bg-black text-white text-[10px] flex items-center justify-center">{i+1}</span>
                            {meal}
                          </h3>
                          {item && typeof item === 'object' && 'name' in (item as object) ? (
                            <div className="space-y-3">
                              <div>
                                <h4 className="text-xl font-bold text-gray-900">{(item as any).name}</h4>
                                <p className="text-sm text-gray-500 font-medium mt-1">{(item as any).grams}</p>
                              </div>
                              <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-50">
                                <span className="bg-gray-100 text-gray-700 px-3 py-1.5 rounded-xl text-[11px] uppercase tracking-wider font-bold">{(item as any).calories} KCAL</span>
                                <span className="bg-blue-50 text-blue-700 px-3 py-1.5 rounded-xl text-[11px] uppercase tracking-wider font-bold">{(item as any).protein}g PRO</span>
                                <span className="bg-orange-50 text-orange-700 px-3 py-1.5 rounded-xl text-[11px] uppercase tracking-wider font-bold">{(item as any).carbs}g CARB</span>
                                <span className="bg-emerald-50 text-emerald-700 px-3 py-1.5 rounded-xl text-[11px] uppercase tracking-wider font-bold">{(item as any).fat}g FAT</span>
                              </div>
                            </div>
                          ) : (
                            <p className="text-lg font-medium text-black leading-relaxed">{item as string}</p>
                          )}
                        </div>
                      ))}
                    </motion.div>
                  ) : weeklyLoading ? (
                    <motion.div
                      key="weekly-loading"
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      className="flex flex-col items-center justify-center py-24 text-center"
                    >
                      <Loader2 className="animate-spin mb-4" size={32} />
                      <p className="text-gray-500 font-medium">Building your 7-day plan — this takes a bit longer than the daily one...</p>
                    </motion.div>
                  ) : weeklyError ? (
                    <motion.div
                      key="weekly-error"
                      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                      className="flex flex-col items-center justify-center py-16 text-center gap-4"
                    >
                      <p className="text-red-600 font-semibold max-w-md">{weeklyError}</p>
                      <Button onClick={handleShowWeekly} variant="outline">Retry</Button>
                    </motion.div>
                  ) : !response.weekly_plan ? null : (
                    <motion.div 
                      key="weekly"
                      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -10 }}
                    >
                      {/* Day Selector Tabs */}
                      <div className="flex flex-wrap justify-center gap-2 mb-8">
                        {['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'].map((day) => (
                          <button
                            key={day}
                            onClick={() => setSelectedDay(day)}
                            className={`px-5 py-3 rounded-2xl text-sm font-bold uppercase tracking-widest transition-all border ${selectedDay === day ? 'bg-black text-white border-black shadow-md' : 'bg-white text-gray-500 border-gray-200 hover:border-gray-400 hover:text-black'}`}
                          >
                            {day.substring(0, 3)}
                          </button>
                        ))}
                      </div>

                      {/* Day Cards */}
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {(() => {
                          const dayPlan = response.weekly_plan[selectedDay] || {};
                          const targetCalories = (dayPlan as any).calories;
                          return (
                            <>
                              {typeof targetCalories === 'number' && (
                                <div className="bg-indigo-50/50 p-8 rounded-[2rem] border border-indigo-100/50 shadow-sm flex items-center justify-between col-span-1 md:col-span-2 group hover:bg-indigo-50 transition-all">
                                  <h3 className="text-sm font-bold text-indigo-500 uppercase tracking-widest flex items-center gap-2">Target Calories</h3>
                                  <p className="text-4xl font-extrabold text-indigo-950">{targetCalories} <span className="text-sm font-bold text-indigo-400">kcal</span></p>
                                </div>
                              )}
                              {orderedMealEntries(dayPlan).map(([meal, info], i) => (
                            <div key={meal} className="bg-white p-8 rounded-[2rem] border border-gray-100 shadow-[0_4px_20px_rgb(0,0,0,0.02)] hover:shadow-[0_8px_30px_rgb(0,0,0,0.06)] transition-all group">
                              <h3 className="text-sm font-bold text-gray-400 uppercase tracking-widest mb-4 flex items-center gap-2">
                                <span className="w-6 h-6 rounded-full bg-black text-white text-[10px] flex items-center justify-center">{i+1}</span>
                                {meal}
                              </h3>
                              {info && typeof info === 'object' && 'name' in (info as object) ? (
                                <div className="space-y-3">
                                  <div>
                                    <h4 className="text-xl font-bold text-gray-900">{(info as any).name}</h4>
                                    <p className="text-sm text-gray-500 font-medium mt-1">{(info as any).grams}</p>
                                  </div>
                                  <div className="flex flex-wrap gap-2 pt-2 border-t border-gray-50">
                                    <span className="bg-gray-100 text-gray-700 px-3 py-1.5 rounded-xl text-[11px] uppercase tracking-wider font-bold">{(info as any).calories} KCAL</span>
                                    <span className="bg-blue-50 text-blue-700 px-3 py-1.5 rounded-xl text-[11px] uppercase tracking-wider font-bold">{(info as any).protein}g PRO</span>
                                    <span className="bg-orange-50 text-orange-700 px-3 py-1.5 rounded-xl text-[11px] uppercase tracking-wider font-bold">{(info as any).carbs}g CARB</span>
                                    <span className="bg-emerald-50 text-emerald-700 px-3 py-1.5 rounded-xl text-[11px] uppercase tracking-wider font-bold">{(info as any).fat}g FAT</span>
                                  </div>
                                </div>
                              ) : (
                                <p className="text-lg font-medium text-black leading-relaxed">{info as string}</p>
                              )}
                            </div>
                              ))}
                            </>
                          );
                        })()}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>

              {/* Expert Tips */}
              <div className="mt-16">
                 <h2 className="text-2xl font-extrabold tracking-tight px-4 mb-6">Expert Guidance</h2>
                 <div className="grid grid-cols-1 gap-4">
                   {response?.tips?.map((tip, idx) => (
                     <motion.div 
                        initial={{ opacity: 0, x: -20 }} 
                        animate={{ opacity: 1, x: 0 }} 
                        transition={{ delay: 0.8 + (idx * 0.1) }}
                        key={idx} 
                        className="bg-indigo-50/50 border border-indigo-100/50 p-6 rounded-2xl flex items-start gap-4 hover:bg-indigo-50 transition-colors"
                     >
                       <div className="bg-indigo-100 rounded-full p-1 border border-indigo-200 shrink-0 mt-0.5"><CheckCircle2 className="text-indigo-600" size={16} /></div>
                       <span className="text-indigo-950 font-medium text-lg leading-snug">{tip}</span>
                     </motion.div>
                   ))}
                 </div>
              </div>

              {/* Reset Control */}
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.5 }} className="pt-16 pb-12 text-center">
                <Button onClick={() => setResponse(null)} variant="outline" className="px-10 py-5 mx-auto hover:bg-black hover:text-white hover:border-black transition-colors">
                  <ArrowLeft size={18} className="mr-3" /> Start Over
                </Button>
              </motion.div>
              
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
