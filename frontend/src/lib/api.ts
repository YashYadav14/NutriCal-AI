import axios from 'axios';

// ── Base clients ──────────────────────────────────────────────────────────────

const BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8080';

/** Unauthenticated client — used only for login/register */
export const authClient = axios.create({
  baseURL: `${BASE_URL}/api/auth`,
  headers: { 'Content-Type': 'application/json' },
});

/** Authenticated client — automatically attaches JWT from localStorage */
const apiClient = axios.create({
  baseURL: `${BASE_URL}/api`,
  headers: { 'Content-Type': 'application/json' },
});

// Attach JWT to every request from apiClient (SSR-safe)
apiClient.interceptors.request.use((config) => {
  const token =
    typeof window !== 'undefined' ? localStorage.getItem('jwt_token') : null;
  if (token) {
    config.headers = config.headers || {};
    config.headers['Authorization'] = `Bearer ${token}`;
  }
  return config;
});

// Redirect to /login on any 401 from apiClient
apiClient.interceptors.response.use(
  (res) => res,
  (error) => {
    if (error.response?.status === 401 && typeof window !== 'undefined') {
      clearToken();
      window.location.href = '/login';
    }
    return Promise.reject(error);
  }
);

// ── Auth helpers ──────────────────────────────────────────────────────────────

const TOKEN_KEY = 'jwt_token';
const USERNAME_KEY = 'username';

export const getToken = (): string | null =>
  typeof window !== 'undefined' ? localStorage.getItem(TOKEN_KEY) : null;

export const isAuthenticated = (): boolean => {
  if (typeof window === 'undefined') return false;
  const hasLocal = !!localStorage.getItem(TOKEN_KEY);
  const hasCookie = document.cookie.includes('jwt_token=');
  
  if (hasLocal && !hasCookie) {
    // If cookie expired or is missing but localStorage stuck around, purge to match server state!
    clearToken();
    return false;
  }
  
  return hasLocal && hasCookie;
};

export const clearToken = (): void => {
  if (typeof window !== 'undefined') {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
    document.cookie = 'jwt_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  }
};

export const logout = (): void => {
  clearToken();
  if (typeof window !== 'undefined') {
      window.location.href = '/login';
  }
};

// ── Auth API ─────────────────────────────────────────────────────────────────

export interface LoginRequest { username: string; password: string; }
export interface LoginResponse { token: string; username: string; }
export interface RegisterRequest { username: string; email: string; password: string; }

export const login = async (req: LoginRequest): Promise<LoginResponse> => {
  const { data } = await authClient.post<LoginResponse>('/login', req);
  if (typeof window !== 'undefined') {
    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USERNAME_KEY, data.username);
    document.cookie = `jwt_token=${data.token}; path=/; max-age=86400; SameSite=Strict`;
  }
  return data;
};

export const register = async (req: RegisterRequest): Promise<void> => {
  await authClient.post('/register', req);
};

// ── AI API ────────────────────────────────────────────────────────────────────

export interface AiRequest {
  weight: number;
  height: number;
  age: number;
  gender: string;
  activityLevel: string;
  goal: string;
  dietaryPreferences: string;
}

export interface MealItem {
  name: string;
  grams: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
}

export interface DailyMeals {
  breakfast: MealItem;
  lunch: MealItem;
  dinner: MealItem;
  snacks: MealItem;
  calories: number;
}

export interface AiDietResponse {
  success?: boolean;
  message?: string;
  error?: string;
  calories: number;
  macros: { protein: number; carbs: number; fats: number };
  meal_plan: { breakfast: MealItem; lunch: MealItem; dinner: MealItem; snacks: MealItem };
  weekly_plan?: Record<string, DailyMeals>;
  tips: string[];
}

export interface AiWeeklyDietResponse {
  success?: boolean;
  message?: string;
  error?: string;
  weekly_plan: Record<string, DailyMeals>;
}

export interface AiRecommendationsResponse {
  summary: string;
  actionable_steps: string[];
  food_to_avoid: string[];
}

export interface ChatMessage { role: 'user' | 'ai'; content: string; }
export interface AiChatRequest { message: string; goal?: string; caloriesTarget?: number; history?: ChatMessage[]; }
export interface AiChatResponse { reply: string; }

const handleAiError = (error: any): never => {
  const status = error.response?.status;
  if (status === 401 || status === 403) {
    if (typeof window !== 'undefined') {
      localStorage.removeItem('jwt_token');
      localStorage.removeItem('username');
      document.cookie = 'jwt_token=; path=/; expires=Thu, 01 Jan 1970 00:00:00 GMT';
      window.location.href = '/login';
    }
    throw new Error('Session expired. Redirecting to login...');
  }
  if (status === 503 || status === 500) {
    const backendMessage = error.response?.data?.error || 'The AI is currently overloaded. Please wait a few seconds and try again.';
    throw new Error(backendMessage); 
  }
  throw new Error(error.response?.data?.message || 'An unexpected API error occurred');
};

const getAuthHeaders = () => {
    let token = '';
    if (typeof window !== 'undefined') {
        token = localStorage.getItem('jwt_token') || '';
    }
    return {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {})
    };
};

export const generateDietPlan = async (req: AiRequest): Promise<AiDietResponse> => {
  try {
    const response = await axios.post<AiDietResponse>(`${BASE_URL}/api/ai/diet`, req, { headers: getAuthHeaders() });
    return response.data;
  } catch (error: any) {
    return handleAiError(error);
  }
};

// Weekly plan is generated separately, on demand, since it's a much larger
// generation than the daily plan and shouldn't block the initial result.
export const generateWeeklyDietPlan = async (req: AiRequest): Promise<AiWeeklyDietResponse> => {
  try {
    const response = await axios.post<AiWeeklyDietResponse>(`${BASE_URL}/api/ai/diet/weekly`, req, { headers: getAuthHeaders() });
    return response.data;
  } catch (error: any) {
    return handleAiError(error);
  }
};

export const generateRecommendations = async (req: AiRequest): Promise<AiRecommendationsResponse> => {
  try {
    const response = await axios.post<AiRecommendationsResponse>(`${BASE_URL}/api/ai/recommendations`, req, { headers: getAuthHeaders() });
    return response.data;
  } catch (error: any) {
    return handleAiError(error);
  }
};

export const sendChatMessage = async (req: AiChatRequest): Promise<AiChatResponse> => {
  try {
    const response = await axios.post<AiChatResponse>(`${BASE_URL}/api/ai/chat`, req, { headers: getAuthHeaders() });
    return response.data;
  } catch (error: any) {
    return handleAiError(error);
  }
};

// ── Health Calculation API ────────────────────────────────────────────────────
// These POST calls persist records to the DB and power the dashboard history.

export interface BmiCalculateRequest { weightKg: number; heightCm: number; }
export interface BmiCalculateResponse { bmi: number; category: string; }

export interface CaloriesCalculateRequest {
  sex: string;          // "MALE" | "FEMALE"
  age: number;
  weightKg: number;
  heightCm: number;
  activityLevel: string; // "SEDENTARY" | "LIGHT" | "MODERATE" | "ACTIVE" | "VERY_ACTIVE"
  goal: string;          // "MAINTAIN" | "CUT" | "BULK"
}
export interface CaloriesCalculateResponse {
  bmr: number; activityFactor: number; tdee: number; goalCalories: number;
}

export interface MacrosCalculateRequest {
  calories: number;
  proteinPercent: number;
  fatPercent: number;
  carbPercent: number; // proteinPercent + fatPercent + carbPercent must === 100
}
export interface MacrosCalculateResponse {
  calories: number; proteinGrams: number; fatGrams: number; carbGrams: number;
}

export const calculateBmi = async (req: BmiCalculateRequest): Promise<BmiCalculateResponse> =>
  (await apiClient.post<BmiCalculateResponse>('/bmi', req)).data;

export const calculateCalories = async (req: CaloriesCalculateRequest): Promise<CaloriesCalculateResponse> =>
  (await apiClient.post<CaloriesCalculateResponse>('/calories', req)).data;

export const calculateMacros = async (req: MacrosCalculateRequest): Promise<MacrosCalculateResponse> =>
  (await apiClient.post<MacrosCalculateResponse>('/macros', req)).data;

// ── History API ───────────────────────────────────────────────────────────────

export interface SavedDietPlan {
  id: number; userId: string; calories: number;
  protein: number; carbs: number; fats: number;
  mealPlanJson: string; weeklyPlanJson?: string; tipsJson: string; createdAt: string;
}
export interface BMIRecord {
  id: number; weightKg: number; heightCm: number;
  bmi: number; category: string; createdAt: string;
}
export interface CaloriesRecord {
  id: number; sex: string; age: number; weightKg: number; heightCm: number;
  activityLevel: string; goal: string; bmr: number;
  activityFactor: number; tdee: number; goalCalories: number; createdAt: string;
}
export interface MacrosRecord {
  id: number; calories: number; proteinPercent: number; fatPercent: number;
  carbPercent: number; proteinGrams: number; fatGrams: number; carbGrams: number; createdAt: string;
}

export const getDietHistory = async (): Promise<SavedDietPlan[]> =>
  (await apiClient.get<SavedDietPlan[]>('/ai/diet/history')).data;

export const getBmiHistory = async (): Promise<BMIRecord[]> =>
  (await apiClient.get<BMIRecord[]>('/bmi/history')).data;

export const getCaloriesHistory = async (): Promise<CaloriesRecord[]> =>
  (await apiClient.get<CaloriesRecord[]>('/calories/history')).data;

export const getMacrosHistory = async (): Promise<MacrosRecord[]> =>
  (await apiClient.get<MacrosRecord[]>('/macros/history')).data;
