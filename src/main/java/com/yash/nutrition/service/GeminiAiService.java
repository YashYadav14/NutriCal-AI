package com.yash.nutrition.service;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.yash.nutrition.dto.AiDietResponse;
import com.yash.nutrition.dto.AiRecommendationsResponse;
import com.yash.nutrition.dto.AiRequest;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.web.reactive.function.client.WebClient;
import reactor.core.publisher.Mono;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.logging.Logger;

@Service
public class GeminiAiService {

    private static final Logger logger = Logger.getLogger(GeminiAiService.class.getName());

    @Value("${gemini.api.key:}")
    private String apiKey;

    @Value("${gemini.api.url}")
    private String apiUrl;

    // If the primary model fails after its own retries, we make ONE attempt against this
    // lighter/less-contested model before giving up. Leave blank to disable fallback.
    @Value("${gemini.api.fallback-url:https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent}")
    private String fallbackApiUrl;

    private static final String TIMEOUT_MSG = "AI is taking longer than expected. Please try again.";
    private static final String UNAVAILABLE_MSG = "AI service is currently unavailable. Please configure the API key to enable this feature.";

    // Small prompt/output (single day) — generous but shouldn't often be needed in full.
    private static final int DAILY_TIMEOUT_SECONDS = 35;
    // Larger prompt/output (7 days x 4 meals x 6 fields) — needs more headroom.
    private static final int WEEKLY_TIMEOUT_SECONDS = 55;
    // Default for chat/recommendations (small, conversational responses).
    private static final int DEFAULT_TIMEOUT_SECONDS = 30;

    private final WebClient webClient;
    private final ObjectMapper objectMapper;
    private final com.yash.nutrition.repository.SavedDietPlanRepository savedDietPlanRepository;

    public GeminiAiService(
            WebClient.Builder webClientBuilder,
            ObjectMapper objectMapper,
            com.yash.nutrition.repository.SavedDietPlanRepository savedDietPlanRepository
    ) {
        this.webClient = webClientBuilder.build();
        this.objectMapper = objectMapper;
        this.savedDietPlanRepository = savedDietPlanRepository;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Fast path: generates ONLY today's plan (calories, macros, meal_plan, tips).
     * Small prompt, small output => reliable within a short timeout.
     */
    public Mono<AiDietResponse> generateDailyDietPlan(AiRequest request, String username) {
        if (isApiKeyMissing()) {
            logger.warning("Gemini API key is missing.");
            return Mono.just(AiDietResponse.error("AI unavailable", UNAVAILABLE_MSG));
        }

        String prompt = buildDailyDietPrompt(request);
        return callWithRetry(prompt, DAILY_TIMEOUT_SECONDS)
                .map(jsonResponse -> {
                    try {
                        AiDietResponse response = objectMapper.readValue(jsonResponse, AiDietResponse.class);
                        if (response == null || response.getCalories() <= 0 || response.getMacros() == null
                                || response.getMeal_plan() == null || response.getMeal_plan().getBreakfast() == null) {
                            return AiDietResponse.error("Validation failed", "Invalid JSON format returned by AI.");
                        }

                        // Persist
                        com.yash.nutrition.entity.SavedDietPlan saved = new com.yash.nutrition.entity.SavedDietPlan();
                        saved.setUserId(username != null ? username : "guest");
                        saved.setCalories(response.getCalories());
                        saved.setProtein(response.getMacros().getProtein());
                        saved.setCarbs(response.getMacros().getCarbs());
                        saved.setFats(response.getMacros().getFats());
                        saved.setMealPlanJson(objectMapper.writeValueAsString(response.getMeal_plan()));
                        saved.setTipsJson(objectMapper.writeValueAsString(response.getTips()));
                        savedDietPlanRepository.save(saved);

                        response.setSuccess(true);
                        return response;
                    } catch (Exception e) {
                        logger.warning("Error parsing daily diet plan: " + e.getMessage());
                        return AiDietResponse.error("Parsing failed", e.getMessage());
                    }
                })
                .onErrorResume(e -> {
                    logger.severe("Gemini AI API Failed (daily): " + e.getMessage());
                    return Mono.error(e);
                });
    }

    /**
     * Separate, on-demand path: generates ONLY the 7-day weekly plan.
     * Larger output than the daily call, so it gets a longer timeout,
     * but it's still far smaller than the old combined daily+weekly prompt.
     */
    public Mono<AiDietResponse> generateWeeklyDietPlan(AiRequest request, String username) {
        if (isApiKeyMissing()) {
            logger.warning("Gemini API key is missing.");
            return Mono.just(AiDietResponse.error("AI unavailable", UNAVAILABLE_MSG));
        }

        // Look up the most recent saved (daily) plan FIRST, so we can lock the weekly
        // prompt to the same calorie/macro target instead of letting the model recompute
        // its own numbers from scratch. Two independent Gemini calls given the same profile
        // are not guaranteed to agree on calories (e.g. 2014 vs 2550) — this keeps them in sync.
        List<com.yash.nutrition.entity.SavedDietPlan> pastPlans =
                savedDietPlanRepository.findByUserIdOrderByCreatedAtDesc(username != null ? username : "guest");
        com.yash.nutrition.entity.SavedDietPlan latest = pastPlans.isEmpty() ? null : pastPlans.get(0);

        String prompt = buildWeeklyDietPrompt(request, latest);
        return callWithRetry(prompt, WEEKLY_TIMEOUT_SECONDS)
                .map(jsonResponse -> {
                    try {
                        AiDietResponse response = objectMapper.readValue(jsonResponse, AiDietResponse.class);
                        if (response == null || response.getWeekly_plan() == null || response.getWeekly_plan().isEmpty()) {
                            return AiDietResponse.error("Validation failed", "Invalid JSON format returned by AI.");
                        }

                        // Attach the weekly plan onto the user's most recent saved plan, if any
                        if (latest != null) {
                            latest.setWeeklyPlanJson(objectMapper.writeValueAsString(response.getWeekly_plan()));
                            savedDietPlanRepository.save(latest);
                        }

                        response.setSuccess(true);
                        return response;
                    } catch (Exception e) {
                        logger.warning("Error parsing weekly diet plan: " + e.getMessage());
                        return AiDietResponse.error("Parsing failed", e.getMessage());
                    }
                })
                .onErrorResume(e -> {
                    logger.severe("Gemini AI API Failed (weekly): " + e.getMessage());
                    return Mono.error(e);
                });
    }

    public Mono<AiRecommendationsResponse> generateRecommendations(AiRequest request) {
        if (isApiKeyMissing()) {
            return Mono.just(getFallbackRecommendationsResponse());
        }

        String prompt = buildRecommendationsPrompt(request);
        return callWithRetry(prompt)
                .map(jsonResponse -> {
                    try {
                        AiRecommendationsResponse response = objectMapper.readValue(jsonResponse, AiRecommendationsResponse.class);
                        if (response == null || response.getSummary() == null
                                || response.getActionable_steps() == null || response.getActionable_steps().isEmpty()) {
                            return AiRecommendationsResponse.error("Validation failed", "Invalid JSON format returned by AI.");
                        }
                        response.setSuccess(true);
                        return response;
                    } catch (Exception e) {
                        return AiRecommendationsResponse.error("Parsing failed", e.getMessage());
                    }
                })
                .onErrorResume(e -> {
                    logger.severe("Gemini AI API Failed: " + e.getMessage());
                    return Mono.error(e);
                });
    }

    public Mono<com.yash.nutrition.dto.AiChatResponse> generateChatResponse(
            AiRequest request, String username) {

        if (isApiKeyMissing()) {
            return Mono.just(com.yash.nutrition.dto.AiChatResponse.error("API Key Missing", UNAVAILABLE_MSG));
        }

        List<com.yash.nutrition.entity.SavedDietPlan> pastPlans =
                savedDietPlanRepository.findByUserIdOrderByCreatedAtDesc(username);
        com.yash.nutrition.entity.SavedDietPlan latestPlan =
                pastPlans.isEmpty() ? null : pastPlans.get(0);

        String prompt = buildChatPrompt(request, latestPlan);

        return callWithRetry(prompt)
                .map(jsonResponse -> {
                    try {
                        com.yash.nutrition.dto.AiChatResponse parsed = objectMapper.readValue(jsonResponse, com.yash.nutrition.dto.AiChatResponse.class);
                        String replyText = parsed != null && parsed.getReply() != null ? parsed.getReply() : "No response";
                        return com.yash.nutrition.dto.AiChatResponse.success(replyText, 0);
                    } catch (Exception e) {
                        // Fallback: try reading as raw string if JSON parsing to DTO fails
                        // The user prompt builder instructs Gemini to return JSON with { "reply": "..." }
                        try {
                            Map<String, String> map = objectMapper.readValue(jsonResponse, Map.class);
                            if (map.containsKey("reply")) {
                                return com.yash.nutrition.dto.AiChatResponse.success(map.get("reply"), 0);
                            }
                        } catch(Exception ignored) {}
                        
                        logger.warning("Error parsing chat response: " + e.getMessage());
                        return com.yash.nutrition.dto.AiChatResponse.error("Parsing failed", e.getMessage());
                    }
                })
                .onErrorResume(e -> {
                    logger.severe("Gemini AI API Failed: " + e.getMessage());
                    return Mono.error(e);
                });
    }

    // ── Internal helpers ──────────────────────────────────────────────────────

    private boolean isApiKeyMissing() {
        return apiKey == null || apiKey.isBlank();
    }

    private Mono<String> callWithRetry(String prompt) {
        return callWithRetry(prompt, DEFAULT_TIMEOUT_SECONDS);
    }

    /**
     * Tries the primary model first. If it fails after its own retries (429/503/timeout),
     * makes ONE attempt against the fallback model before giving up entirely.
     * This keeps result quality high when possible while adding resilience against
     * free-tier overload, without permanently switching everyone to the lighter model.
     */
    private Mono<String> callWithRetry(String prompt, int timeoutSeconds) {
        Mono<String> primaryAttempt = attemptCall(prompt, timeoutSeconds, apiUrl);

        if (fallbackApiUrl == null || fallbackApiUrl.isBlank() || fallbackApiUrl.equals(apiUrl)) {
            return primaryAttempt;
        }

        return primaryAttempt.onErrorResume(primaryError -> {
            logger.warning("Primary Gemini model failed, trying fallback model. Reason: " + primaryError.getMessage());
            return attemptCall(prompt, timeoutSeconds, fallbackApiUrl)
                    .doOnSuccess(r -> logger.info("Fallback model succeeded."))
                    .onErrorResume(fallbackError -> {
                        logger.severe("Fallback Gemini model also failed: " + fallbackError.getMessage());
                        // Surface the ORIGINAL error — it's usually more informative (e.g. real 503 vs timeout).
                        return Mono.error(primaryError);
                    });
        });
    }

    @SuppressWarnings("unchecked")
    private Mono<String> attemptCall(String prompt, int timeoutSeconds, String url) {
        String fullUrl = url + "?key=" + apiKey;
        String sanitizedPrompt = prompt.replace("\"", "\\\"").replace("\n", " ");

        String requestBody = """
            {
              "contents": [
                {
                  "parts": [
                    {
                      "text": "%s"
                    }
                  ]
                }
              ]
            }
            """.formatted(sanitizedPrompt);

        return webClient.post()
                .uri(fullUrl)
                .header("Content-Type", "application/json")
                .bodyValue(requestBody)
                .retrieve()
                .bodyToMono(Map.class)
                .timeout(Duration.ofSeconds(timeoutSeconds))
                .retryWhen(reactor.util.retry.Retry.backoff(3, Duration.ofSeconds(2))
                        .filter(throwable -> {
                            if (throwable instanceof org.springframework.web.reactive.function.client.WebClientResponseException) {
                                int status = ((org.springframework.web.reactive.function.client.WebClientResponseException) throwable).getStatusCode().value();
                                return status == 429 || status == 503;
                            }
                            return false;
                        }))
                .map(body -> {
                    if (body == null || !body.containsKey("candidates")
                            || ((List<?>) body.get("candidates")).isEmpty()) {
                        throw new RuntimeException("Invalid or empty response format from Gemini API");
                    }
                    List<Map<String, Object>> candidates = (List<Map<String, Object>>) body.get("candidates");
                    Map<String, Object> content = (Map<String, Object>) candidates.get(0).get("content");
                    List<Map<String, Object>> parts = (List<Map<String, Object>>) content.get("parts");
                    String textResponse = (String) parts.get(0).get("text");

                    String cleanResponse = textResponse
                            .replaceAll("```json", "")
                            .replaceAll("```", "")
                            .replaceAll("`json", "")
                            .replaceAll("`", "")
                            .trim();
                    System.out.println("========== RAW GEMINI API RESPONSE (" + url + ") ==========");
                    System.out.println(cleanResponse);
                    System.out.println("=============================================");
                    return cleanResponse;
                });
    }

    // ── Prompt builders ───────────────────────────────────────────────────────

    private static final String MEAL_ITEM_SCHEMA =
            "{ \"name\": \"string (be specific — e.g. '2 boiled eggs, 1 slice whole wheat toast, 1/2 avocado', not just 'eggs')\", " +
            "\"grams\": \"string (total grams for the whole meal, e.g. '250g')\", " +
            "\"calories\": number, \"protein\": number, \"carbs\": number, \"fat\": number }";

    private String buildDailyDietPrompt(AiRequest request) {
        return "You are a professional nutritionist.\n" +
               "Generate ONE DAY of a personalized, precise diet plan based on the following user profile:\n" +
               "Weight: " + request.getWeight() + " kg\n" +
               "Height: " + request.getHeight() + " cm\n" +
               "Age: " + request.getAge() + " years\n" +
               "Gender: " + request.getGender() + "\n" +
               "Activity Level: " + request.getActivityLevel() + "\n" +
               "Goal: " + request.getGoal() + "\n" +
               "Dietary Preferences: " + request.getDietaryPreferences() + "\n\n" +
               "IMPORTANT DATA RULES:\n" +
               "- Every meal MUST name specific foods and exact quantities needed to hit its calorie/macro target " +
               "(e.g. '3 whole eggs + 1 cup oats + 1 banana + 200ml milk'), never a single generic word like 'Eggs' or 'Oats'.\n" +
               "- All numeric values MUST be integers (no quotes, no units like \"150g\").\n" +
               "- Ensure macros (protein, carbs, fats) are strictly integer numbers.\n" +
               "- Ensure calories is strictly an integer number.\n" +
               "- The four meals' calories must sum to (approximately) the daily \"calories\" value.\n\n" +
               "Return ONLY valid JSON. No explanation. No markdown. No backticks.\n" +
               "Output must strictly follow this structure:\n" +
               "{\n" +
               "  \"calories\": number,\n" +
               "  \"macros\": { \"protein\": number, \"carbs\": number, \"fats\": number },\n" +
               "  \"meal_plan\": {\n" +
               "    \"breakfast\": " + MEAL_ITEM_SCHEMA + ",\n" +
               "    \"lunch\": " + MEAL_ITEM_SCHEMA + ",\n" +
               "    \"dinner\": " + MEAL_ITEM_SCHEMA + ",\n" +
               "    \"snacks\": " + MEAL_ITEM_SCHEMA + "\n" +
               "  },\n" +
               "  \"tips\": [\"string\"]\n" +
               "}";
    }

    private String buildWeeklyDietPrompt(AiRequest request, com.yash.nutrition.entity.SavedDietPlan latestPlan) {
        // Lock the weekly plan onto the SAME calorie/macro target as the user's most recent
        // daily plan (if one exists), rather than letting the model derive its own number
        // again from scratch — that's what was causing the daily/weekly mismatch.
        String targetBlock;
        if (latestPlan != null && latestPlan.getCalories() > 0) {
            targetBlock =
                "FIXED DAILY TARGET (already calculated for this user — do NOT recalculate or deviate from it):\n" +
                "- Calories: " + latestPlan.getCalories() + " kcal per day\n" +
                "- Protein: " + latestPlan.getProtein() + "g, Carbs: " + latestPlan.getCarbs() +
                "g, Fats: " + latestPlan.getFats() + "g per day\n" +
                "EVERY one of the 7 days must land within about 3% of these exact numbers. " +
                "Vary the FOODS across days, never the calorie/macro target.\n\n";
        } else {
            targetBlock = "";
        }

        return "You are a professional nutritionist.\n" +
               "Generate a 7-DAY personalized, precise diet plan based on the following user profile:\n" +
               "Weight: " + request.getWeight() + " kg\n" +
               "Height: " + request.getHeight() + " cm\n" +
               "Age: " + request.getAge() + " years\n" +
               "Gender: " + request.getGender() + "\n" +
               "Activity Level: " + request.getActivityLevel() + "\n" +
               "Goal: " + request.getGoal() + "\n" +
               "Dietary Preferences: " + request.getDietaryPreferences() + "\n\n" +
               targetBlock +
               "IMPORTANT DATA RULES:\n" +
               "- Every meal MUST name specific foods and exact quantities needed to hit its calorie/macro target " +
               "(e.g. '3 whole eggs + 1 cup oats + 1 banana + 200ml milk'), never a single generic word like 'Eggs' or 'Oats'.\n" +
               "- Vary the meals across the 7 days — do not repeat the same meal every day.\n" +
               "- All numeric values MUST be integers (no quotes, no units like \"150g\").\n" +
               "- Each day's four meals' calories must sum to (approximately) that day's \"calories\" value, " +
               "and that day's \"calories\" value must match the FIXED DAILY TARGET above (if given).\n\n" +
               "Return ONLY valid JSON. No explanation. No markdown. No backticks.\n" +
               "Output must strictly follow this structure (repeat for all 7 days — " +
               "monday, tuesday, wednesday, thursday, friday, saturday, sunday):\n" +
               "{\n" +
               "  \"weekly_plan\": {\n" +
               "    \"monday\": { \"breakfast\": " + MEAL_ITEM_SCHEMA + ", \"lunch\": " + MEAL_ITEM_SCHEMA +
               ", \"dinner\": " + MEAL_ITEM_SCHEMA + ", \"snacks\": " + MEAL_ITEM_SCHEMA + ", \"calories\": number }\n" +
               "  }\n" +
               "}";
    }

    private String buildRecommendationsPrompt(AiRequest request) {
        return "You are a professional nutritionist giving general advice.\n" +
               "Based on the following user profile, provide a summary and actionable steps.\n\n" +
               "Age: " + request.getAge() + "\n" +
               "Gender: " + request.getGender() + "\n" +
               "Weight: " + request.getWeight() + " kg\n" +
               "Height: " + request.getHeight() + " cm\n" +
               "Activity Level: " + request.getActivityLevel() + "\n" +
               "Goal: " + request.getGoal() + "\n" +
               "Dietary Preferences: " + request.getDietaryPreferences() + "\n\n" +
               "Return ONLY valid JSON. No explanation. No markdown. No backticks.\n" +
               "Output must strictly follow this structure:\n" +
               "{\n" +
               "  \"summary\": \"string\",\n" +
               "  \"actionable_steps\": [\"string\"],\n" +
               "  \"food_to_avoid\": [\"string\"]\n" +
               "}";
    }

    private String buildChatPrompt(
            AiRequest request,
            com.yash.nutrition.entity.SavedDietPlan latestPlan) {

        StringBuilder prompt = new StringBuilder();
        prompt.append("You are a professional, motivating AI Nutrition Coach.\n");
        prompt.append("Keep responses short, conversational, helpful, and practical.\n");
        prompt.append("CRITICAL RULE: NEVER exceed 4-5 short sentences in your reply.\n\n");

        if (latestPlan != null) {
            prompt.append("--- USER'S LATEST SAVED DIET PLAN ---\n");
            prompt.append("Target Calories: ").append(latestPlan.getCalories()).append(" kcal\n");
            prompt.append("Protein: ").append(latestPlan.getProtein()).append("g, ");
            prompt.append("Carbs: ").append(latestPlan.getCarbs()).append("g, ");
            prompt.append("Fats: ").append(latestPlan.getFats()).append("g\n");
            prompt.append("Meal Plan: ").append(latestPlan.getMealPlanJson()).append("\n");
            prompt.append("--------------------------------------\n\n");
        } else {
            if (request.getGoal() != null && !request.getGoal().isBlank()) {
                prompt.append("User's goal: ").append(request.getGoal()).append(".\n");
            }
            if (request.getCaloriesTarget() != null && request.getCaloriesTarget() > 0) {
                prompt.append("Daily target: ").append(request.getCaloriesTarget()).append(" calories.\n");
            }
        }

        if (request.getHistory() != null && !request.getHistory().isEmpty()) {
            prompt.append("--- CONVERSATION HISTORY ---\n");
            for (com.yash.nutrition.dto.ChatMessage msg : request.getHistory()) {
                prompt.append(msg.getRole().toUpperCase()).append(": ").append(msg.getContent()).append("\n");
            }
            prompt.append("----------------------------\n\n");
        }

        prompt.append("User's latest message: \"").append(request.getMessage()).append("\"\n\n");
        prompt.append("Return ONLY valid JSON. No markdown. No backticks.\n");
        prompt.append("Output must strictly follow this structure:\n");
        prompt.append("{\n  \"reply\": \"your conversational response here\"\n}");

        return prompt.toString();
    }

    // ── Fallback responses ────────────────────────────────────────────────────

    private AiRecommendationsResponse getFallbackRecommendationsResponse() {
        AiRecommendationsResponse fallback = new AiRecommendationsResponse();
        fallback.setSummary("General healthy living advice — personalised recommendations unavailable right now.");

        List<String> steps = new ArrayList<>();
        steps.add("Maintain a balanced diet rich in whole foods.");
        steps.add("Aim for at least 150 minutes of moderate aerobic activity per week.");
        fallback.setActionable_steps(steps);

        List<String> avoid = new ArrayList<>();
        avoid.add("Highly processed foods");
        avoid.add("Excessive added sugars");
        fallback.setFood_to_avoid(avoid);

        return fallback;
    }
}
