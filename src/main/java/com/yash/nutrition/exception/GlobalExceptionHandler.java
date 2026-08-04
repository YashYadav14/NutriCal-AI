package com.yash.nutrition.exception;

import io.jsonwebtoken.ExpiredJwtException;
import io.jsonwebtoken.MalformedJwtException;
import io.jsonwebtoken.UnsupportedJwtException;
import io.jsonwebtoken.security.SignatureException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.core.userdetails.UsernameNotFoundException;
import org.springframework.web.bind.annotation.ControllerAdvice;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.context.request.async.AsyncRequestTimeoutException;

import java.util.HashMap;
import java.util.Map;
import java.util.logging.Logger;

@ControllerAdvice
public class GlobalExceptionHandler {

    private static final Logger logger = Logger.getLogger(GlobalExceptionHandler.class.getName());

    @ExceptionHandler({ExpiredJwtException.class})
    public ResponseEntity<Map<String, String>> handleExpiredJwt(ExpiredJwtException ex) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(Map.of("error", "Token expired"));
    }

    @ExceptionHandler({MalformedJwtException.class, UnsupportedJwtException.class, SignatureException.class})
    public ResponseEntity<Map<String, String>> handleInvalidJwt(Exception ex) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(Map.of("error", "Invalid token"));
    }

    @ExceptionHandler({BadCredentialsException.class, UsernameNotFoundException.class})
    public ResponseEntity<Map<String, String>> handleAuthFailure(Exception ex) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED)
                .body(Map.of("error", "Invalid username or password"));
    }

    // The container (Tomcat) aborts a long-running async request (e.g. Mono-based
    // AI controller methods) if it exceeds spring.mvc.async.request-timeout.
    // This is a normal, expected outcome for a slow AI call, not a server bug —
    // report it the same way the AI controllers themselves report overload (503),
    // so the frontend shows "try again" instead of anything auth-related.
    @ExceptionHandler(AsyncRequestTimeoutException.class)
    public ResponseEntity<Map<String, String>> handleAsyncTimeout(AsyncRequestTimeoutException ex) {
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .body(Map.of("error", "The AI is taking longer than expected. Please try again."));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Map<String, String>> handleAllExceptions(Exception ex) {
        // ex.getMessage() can legitimately be null (many exception types don't set one).
        // Map.of() throws NullPointerException on any null value, which would crash
        // this handler itself and mask the real error with an opaque failure — so
        // build the body defensively instead.
        logger.warning("Unhandled exception: " + ex.getClass().getName() + " - " + ex.getMessage());
        Map<String, String> body = new HashMap<>();
        body.put("error", "An unexpected error occurred");
        body.put("details", ex.getMessage() != null ? ex.getMessage() : ex.getClass().getSimpleName());
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(body);
    }
}
