//! YouTube-specific ad detection and filtering logic.
//!
//! This module provides specialized handling for YouTube's unique ad formats,
//! including server-side ad insertion (SSAI) detection and player response parsing.
//! The functions here are optimized for performance and called from the content
//! script via WebAssembly.

use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};

/// Represents an ad segment with timing information in milliseconds.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AdSegment {
    pub start_ms: u64,
    pub end_ms: u64,
}

/// Parsed result from a YouTube player response.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayerResponseAnalysis {
    pub has_ads: bool,
    pub ad_segments: Vec<AdSegment>,
    pub is_ssai: bool,
    pub ad_count: usize,
}

/// Analyzes a YouTube player response JSON string for ad segments.
/// 
/// This function parses the player response that YouTube uses to configure
/// video playback and extracts any ad-related timing information. This is
/// crucial for detecting server-side ad insertion (SSAI) where ads are
/// embedded directly into the video stream.
///
/// # Arguments
/// * `player_response_json` - JSON string of the ytInitialPlayerResponse object
///
/// # Returns
/// A `PlayerResponseAnalysis` containing detected ad segments and metadata.
#[wasm_bindgen]
pub fn analyze_youtube_player_response(player_response_json: &str) -> String {
    let analysis = parse_player_response(player_response_json);
    
    // Serialize to JSON for JS consumption
    serde_json::to_string(&analysis).unwrap_or_else(|_| "{}".to_string())
}

fn parse_player_response(json_str: &str) -> PlayerResponseAnalysis {
    let mut ad_segments = Vec::new();
    let mut has_ads = false;
    let mut is_ssai = false;
    
    // Use a simple JSON parser approach - we look for specific keys
    // In production, you might use serde_json with proper types
    
    // Check for adBreaks array
    if let Some(ad_breaks) = extract_array_field(json_str, "adBreaks") {
        for break_entry in ad_breaks {
            if let Some(segment) = parse_ad_break(&break_entry) {
                ad_segments.push(segment);
                has_ads = true;
            }
        }
    }
    
    // Check for playerAds array
    if let Some(player_ads) = extract_array_field(json_str, "playerAds") {
        for ad_entry in player_ads {
            if let Some(segment) = parse_player_ad(&ad_entry) {
                ad_segments.push(segment);
                has_ads = true;
            }
        }
    }
    
    // Check for SSAI indicators
    if json_str.contains("adManifestUrl") || json_str.contains("serverSideAd") {
        is_ssai = true;
        has_ads = true;
    }
    
    // Check for streamingData with ad indicators
    if let Some(streaming_data) = extract_object_field(json_str, "streamingData") {
        if streaming_data.contains("adManifestUrl") {
            is_ssai = true;
            has_ads = true;
        }
    }
    
    PlayerResponseAnalysis {
        has_ads,
        ad_segments,
        is_ssai,
        ad_count: ad_segments.len(),
    }
}

fn parse_ad_break(break_json: &str) -> Option<AdSegment> {
    let start_ms = extract_number_field(break_json, "startTimeMs")
        .or_else(|| extract_number_field(break_json, "startMs"))
        .unwrap_or(0);
    
    let duration_ms = extract_number_field(break_json, "durationMs");
    let end_ms = extract_number_field(break_json, "endTimeMs");
    
    let end_ms = if end_ms > 0 {
        end_ms
    } else if let Some(duration) = duration_ms {
        start_ms + duration
    } else {
        start_ms + 15000 // Default 15 second ad
    };
    
    if start_ms > 0 && end_ms > start_ms {
        Some(AdSegment { start_ms, end_ms })
    } else {
        None
    }
}

fn parse_player_ad(ad_json: &str) -> Option<AdSegment> {
    let start_ms = extract_number_field(ad_json, "startTimeMs")
        .or_else(|| extract_number_field(ad_json, "positionMs"))
        .unwrap_or(0);
    
    let duration_ms = extract_number_field(ad_json, "durationMs").unwrap_or(15000);
    let end_ms = extract_number_field(ad_json, "endTimeMs")
        .unwrap_or(start_ms + duration_ms);
    
    if start_ms > 0 && end_ms > start_ms {
        Some(AdSegment { start_ms, end_ms })
    } else {
        None
    }
}

/// Checks if a given playback position falls within any ad segment.
/// 
/// # Arguments
/// * `segments_json` - JSON array of ad segments [{start_ms, end_ms}, ...]
/// * `current_time_seconds` - Current playback position in seconds
///
/// # Returns
/// `true` if currently in an ad segment, `false` otherwise
#[wasm_bindgen]
pub fn is_in_ad_segment(segments_json: &str, current_time_seconds: f64) -> bool {
    let current_ms = (current_time_seconds * 1000.0) as u64;
    
    // Simple parsing of JSON array
    if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(segments_json) {
        for seg in arr {
            if let (Some(start), Some(end)) = (
                seg.get("start_ms").and_then(|v| v.as_u64()),
                seg.get("end_ms").and_then(|v| v.as_u64()),
            ) {
                if current_ms >= start && current_ms < end {
                    return true;
                }
            }
        }
    }
    false
}

/// Calculates the optimal skip position to jump past an ad segment.
/// 
/// # Arguments
/// * `segments_json` - JSON array of ad segments
/// * `current_time_seconds` - Current playback position in seconds
/// * `video_duration_seconds` - Total video duration in seconds
///
/// # Returns
/// Target time in seconds to seek to, or -1.0 if not in an ad segment
#[wasm_bindgen]
pub fn get_skip_position_for_ad(segments_json: &str, current_time_seconds: f64, video_duration_seconds: f64) -> f64 {
    let current_ms = (current_time_seconds * 1000.0) as u64;
    let video_end_ms = (video_duration_seconds * 1000.0) as u64;
    
    if let Ok(arr) = serde_json::from_str::<Vec<serde_json::Value>>(segments_json) {
        for seg in arr {
            if let (Some(start), Some(end)) = (
                seg.get("start_ms").and_then(|v| v.as_u64()),
                seg.get("end_ms").and_then(|v| v.as_u64()),
            ) {
                if current_ms >= start && current_ms < end {
                    // Return position just after the ad segment ends
                    let target_ms = std::cmp::min(end + 100, video_end_ms);
                    return target_ms as f64 / 1000.0;
                }
            }
        }
    }
    -1.0
}

// Helper functions for basic JSON parsing without full deserialization

fn extract_array_field(json: &str, field_name: &str) -> Option<Vec<String>> {
    let pattern = format!("\"{}\"", field_name);
    if let Some(pos) = json.find(&pattern) {
        let rest = &json[pos + pattern.len()..];
        if let Some(start) = rest.find('[') {
            let mut depth = 0;
            let mut end = 0;
            let chars: Vec<char> = rest[start..].chars().collect();
            
            for (i, c) in chars.iter().enumerate() {
                match c {
                    '[' => depth += 1,
                    ']' => {
                        depth -= 1;
                        if depth == 0 {
                            end = i;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            
            if end > 0 {
                let array_str = &rest[start + 1..start + end];
                // Split by },{ to get individual objects
                return Some(split_json_objects(array_str));
            }
        }
    }
    None
}

fn extract_object_field(json: &str, field_name: &str) -> Option<String> {
    let pattern = format!("\"{}\"", field_name);
    if let Some(pos) = json.find(&pattern) {
        let rest = &json[pos + pattern.len()..];
        if let Some(start) = rest.find('{') {
            let mut depth = 0;
            let mut end = 0;
            let chars: Vec<char> = rest[start..].chars().collect();
            
            for (i, c) in chars.iter().enumerate() {
                match c {
                    '{' => depth += 1,
                    '}' => {
                        depth -= 1;
                        if depth == 0 {
                            end = i;
                            break;
                        }
                    }
                    _ => {}
                }
            }
            
            if end > 0 {
                return Some(rest[start..=end].to_string());
            }
        }
    }
    None
}

fn extract_number_field(json: &str, field_name: &str) -> Option<u64> {
    let pattern = format!("\"{}\":", field_name);
    if let Some(pos) = json.find(&pattern) {
        let rest = &json[pos + pattern.len()..];
        let trimmed = rest.trim_start();
        
        // Extract the number
        let num_str: String = trimmed.chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        
        if !num_str.is_empty() {
            return num_str.parse().ok();
        }
    }
    None
}

fn split_json_objects(array_str: &str) -> Vec<String> {
    let mut objects = Vec::new();
    let mut depth = 0;
    let mut start = 0;
    let mut in_string = false;
    let mut escape_next = false;
    
    let chars: Vec<char> = array_str.chars().collect();
    
    for (i, c) in chars.iter().enumerate() {
        if escape_next {
            escape_next = false;
            continue;
        }
        
        match c {
            '"' if !escape_next => in_string = !in_string,
            '\\' if in_string => escape_next = true,
            '{' if !in_string => {
                if depth == 0 {
                    start = i;
                }
                depth += 1;
            }
            '}' if !in_string => {
                depth -= 1;
                if depth == 0 {
                    objects.push(array_str[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    
    objects
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_simple_ad_break() {
        let json = r#"{"adBreaks":[{"startTimeMs":5000,"durationMs":15000}]}"#;
        let result = parse_player_response(json);
        assert!(result.has_ads);
        assert_eq!(result.ad_segments.len(), 1);
        assert_eq!(result.ad_segments[0].start_ms, 5000);
        assert_eq!(result.ad_segments[0].end_ms, 20000);
    }

    #[test]
    fn test_detect_ssai() {
        let json = r#"{"streamingData":{"adManifestUrl":"https://example.com/ad"}}"#;
        let result = parse_player_response(json);
        assert!(result.has_ads);
        assert!(result.is_ssai);
    }

    #[test]
    fn test_is_in_ad_segment() {
        let segments = r#"[{"start_ms":5000,"end_ms":20000},{"start_ms":60000,"end_ms":75000}]"#;
        
        // In first ad
        assert!(is_in_ad_segment(segments, 10.0));
        
        // Between ads
        assert!(!is_in_ad_segment(segments, 30.0));
        
        // In second ad
        assert!(is_in_ad_segment(segments, 65.0));
        
        // After all ads
        assert!(!is_in_ad_segment(segments, 80.0));
    }

    #[test]
    fn test_get_skip_position() {
        let segments = r#"[{"start_ms":5000,"end_ms":20000}]"#;
        
        // In ad at 10s should skip to just after 20s
        let pos = get_skip_position_for_ad(segments, 10.0, 120.0);
        assert!(pos > 20.0 && pos <= 20.1);
        
        // Not in ad returns -1
        assert_eq!(get_skip_position_for_ad(segments, 30.0, 120.0), -1.0);
    }
}
