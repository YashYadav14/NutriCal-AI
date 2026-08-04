package com.yash.nutrition.controller;

import com.yash.nutrition.dto.AiDietResponse;
import com.yash.nutrition.dto.AiRecommendationsResponse;
import com.yash.nutrition.dto.AiRequest;
import com.yash.nutrition.entity.SavedDietPlan;
import com.yash.nutrition.repository.SavedDietPlanRepository;
import com.yash.nutrition.service.GeminiAiService;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import reactor.core.publisher.Mono;

import java.security.Principal;
import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/ai")
public class AiAssistantController {

    private final GeminiAiService geminiAiService;
    private final SavedDietPlanRepository savedDietPlanRepository;

    @Autowired
    public AiAssistantController(GeminiAiService geminiAiService, SavedDietPlanRepository savedDietPlanRepository) {
        this.geminiAiService = geminiAiService;
        this.savedDietPlanRepository = savedDietPlanRepository;
    }

    @PostMapping("/diet")
    public Mono<ResponseEntity<?>> getDietPlan(@RequestBody AiRequest request, Principal principal) {
        String username = principal != null ? principal.getName() : "guest";
        return geminiAiService.generateDailyDietPlan(request, username)
                .<ResponseEntity<?>>map(ResponseEntity::ok)
                .onErrorResume(this::handleAiError);
    }

    @PostMapping("/diet/weekly")
    public Mono<ResponseEntity<?>> getWeeklyDietPlan(@RequestBody AiRequest request, Principal principal) {
        String username = principal != null ? principal.getName() : "guest";
        return geminiAiService.generateWeeklyDietPlan(request, username)
                .<ResponseEntity<?>>map(ResponseEntity::ok)
                .onErrorResume(this::handleAiError);
    }

    @PostMapping("/recommendations")
    public Mono<ResponseEntity<?>> getRecommendations(@RequestBody AiRequest request) {
        return geminiAiService.generateRecommendations(request)
                .<ResponseEntity<?>>map(ResponseEntity::ok)
                .onErrorResume(this::handleAiError);
    }

    @GetMapping("/diet/history")
    public ResponseEntity<List<SavedDietPlan>> getDietHistory(Principal principal) {
        String username = principal != null ? principal.getName() : "guest";
        List<SavedDietPlan> history = savedDietPlanRepository.findByUserIdOrderByCreatedAtDesc(username);
        return ResponseEntity.ok(history);
    }

    @PostMapping("/chat")
    public Mono<ResponseEntity<?>> chatWithAi(@RequestBody AiRequest request, Principal principal) {
        String username = principal != null ? principal.getName() : "guest";
        return geminiAiService.generateChatResponse(request, username)
                .<ResponseEntity<?>>map(ResponseEntity::ok)
                .onErrorResume(this::handleAiError);
    }

    private Mono<ResponseEntity<?>> handleAiError(Throwable e) {
        return Mono.just(ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .body(Map.of("error", "The AI is currently overloaded. Please wait a few seconds and try again.")));
    }
}
