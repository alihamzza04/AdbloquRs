import {
  Box,
  Heading,
  Text,
  VStack,
  HStack,
  Icon,
  Flex,
  Separator,
  IconButton,
  Button,
  Badge,
} from "@chakra-ui/react"
import { Switch } from "@/components/ui/switch"
import {
  StatRoot,
  StatLabel,
  StatValueText,
} from "@/components/ui/stat"
import { Alert } from "@/components/ui/alert"
import { ColorModeButton, useColorModeValue } from "@/components/ui/color-mode"
import {
  ProgressCircleRoot,
  ProgressCircleRing,
} from "@/components/ui/progress-circle"
import {
  LuShield,
  LuShieldCheck,
  LuShieldX,
  LuShieldAlert,
  LuBan,
  LuGlobe,
  LuPlus,
  LuTrash2,
  LuPause,
  LuPlay,
  LuRadar,
  LuVideo,
} from "react-icons/lu"
import { useEffect, useCallback, useState } from "react"

type PopupState = {
  paused: boolean
  siteAllowlist: string[]
  trackingAllowlist: string[]
  adsBlocked: number
  trackersBlocked: number
  youtubeAdsBlocked: number
  checkedCount: number
  ruleCount: number
  trackingRuleCount: number
  version: string
  currentDomain: string
  loading: boolean
  feedback: { kind: "success" | "info" | "error"; message: string } | null
}

const INITIAL_STATE: PopupState = {
  paused: false,
  siteAllowlist: [],
  trackingAllowlist: [],
  adsBlocked: 0,
  trackersBlocked: 0,
  youtubeAdsBlocked: 0,
  checkedCount: 0,
  ruleCount: 0,
  trackingRuleCount: 0,
  version: "",
  currentDomain: "",
  loading: true,
  feedback: null,
}

function sendMessage<T>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else {
        resolve(response as T)
      }
    })
  })
}

// Mirror of the engine's subdomain matching, used only for display.
function domainListed(list: string[], domain: string): boolean {
  const bare = domain.replace(/^www\./, "").toLowerCase()
  return list.some((entry) => {
    const listed = entry.replace(/^www\./, "").toLowerCase()
    return bare === listed || bare.endsWith(`.${listed}`)
  })
}

// Compact count for the stat cards (12,345 -> "12.3K").
const compactCount: Intl.NumberFormatOptions = {
  notation: "compact",
  maximumFractionDigits: 1,
}

export default function Popup() {
  const [state, setState] = useState<PopupState>(INITIAL_STATE)

  // Palette: the warm cream theme in light mode (unchanged), a warm dark
  // counterpart in dark mode. All colors go through these so the
  // ColorModeButton actually switches the whole popup.
  const bgPage = useColorModeValue("#FEF4EC", "#1B1612")
  const cardBg = useColorModeValue("#F5EDE6", "#262019")
  const cardBorder = useColorModeValue("#E0D4C8", "#3B3128")
  const hoverBg = useColorModeValue(`${cardBorder}80`, "rgba(255,255,255,0.07)")
  const accentBrown = useColorModeValue("#865D3B", "#D9A05B")
  const accentBrownDark = useColorModeValue("#6B4A2F", "#E3B57F")
  const textDark = useColorModeValue("#4A3728", "#F3E9DE")
  const textMuted = useColorModeValue("#9A8577", "#A3907F")
  const greenBg = useColorModeValue("#E8F5E9", "#20362A")
  const greenFg = useColorModeValue("#2E7D32", "#8FD09A")
  const orangeBg = useColorModeValue("#FFF3E0", "#3A2A16")
  const orangeFg = useColorModeValue("#E65100", "#FFB74D")
  const adRed = useColorModeValue("#C62828", "#EF5350")
  const trackerOrange = useColorModeValue("#E65100", "#FFA726")
  const blueBg = useColorModeValue("#E3F2FD", "#1C2A3A")
  const blueFg = useColorModeValue("#1565C0", "#82B1FF")
  const chipBg = useColorModeValue("#D7CCC8", "#3B3128")
  const chipHover = useColorModeValue("#BCAAA4", "#4A3E33")
  const statusColorPaused = useColorModeValue("#C48868", "#E8A87C")
  const statusColorAllowed = useColorModeValue("#B8756D", "#C98A80")
  const blockBtnBg = useColorModeValue("#B8756D", "#C98A80")
  const blockBtnHover = useColorModeValue("#A0645D", "#B8756D")

  const refreshState = useCallback(async () => {
    try {
      const [engineState, tabInfo] = await Promise.all([
        sendMessage<Omit<PopupState, "currentDomain" | "loading" | "feedback">>(
          { type: "getState" },
        ),
        sendMessage<{ domain: string }>({ type: "getActiveTabDomain" }),
      ])
      setState((prev) => ({
        ...prev,
        ...engineState,
        currentDomain: tabInfo.domain || "",
        loading: false,
      }))
    } catch {
      setState((prev) => ({ ...prev, loading: false }))
    }
  }, [])

  useEffect(() => {
    // Fetching on mount is the only path that populates the popup; the
    // engine is cold-started by the service worker on first message.
    refreshState()
  }, [refreshState])

  const handleTogglePause = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true }))
    try {
      const message = state.paused ? { type: "resume" } : { type: "pause" }
      const res = await sendMessage<{ ok: boolean; paused: boolean }>(message)
      setState((prev) => ({
        ...prev,
        paused: res.paused,
        loading: false,
        feedback: {
          kind: "success",
          message: res.paused ? "Blocking paused" : "Blocking resumed",
        },
      }))
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        feedback: { kind: "error", message: String(err) },
      }))
    }
  }, [state.paused])

  const handleAddSiteToAllowlist = useCallback(async () => {
    if (!state.currentDomain) return
    setState((prev) => ({ ...prev, loading: true }))
    try {
      const res = await sendMessage<{ ok: boolean; siteAllowlist: string[] }>({
        type: "addSiteAllowlist",
        domain: state.currentDomain,
      })
      setState((prev) => ({
        ...prev,
        siteAllowlist: res.siteAllowlist || [],
        loading: false,
        feedback: {
          kind: "success",
          message: `${state.currentDomain} added to allowlist`,
        },
      }))
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        feedback: { kind: "error", message: String(err) },
      }))
    }
  }, [state.currentDomain])

  const handleRemoveSiteFromAllowlist = useCallback(async (domain: string) => {
    setState((prev) => ({ ...prev, loading: true }))
    try {
      const res = await sendMessage<{ ok: boolean; siteAllowlist: string[] }>({
        type: "moveSiteToBlocklist",
        domain,
      })
      setState((prev) => ({
        ...prev,
        siteAllowlist: res.siteAllowlist || [],
        loading: false,
        feedback: {
          kind: "info",
          message: `${domain} moved back to blocklist`,
        },
      }))
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        feedback: { kind: "error", message: String(err) },
      }))
    }
  }, [])

  const handleAllowCurrentTrackers = useCallback(async () => {
    if (!state.currentDomain) return
    setState((prev) => ({ ...prev, loading: true }))
    try {
      const res = await sendMessage<{
        ok: boolean
        trackingAllowlist: string[]
      }>({
        type: "addTrackingAllow",
        domain: state.currentDomain,
      })
      setState((prev) => ({
        ...prev,
        trackingAllowlist: res.trackingAllowlist || [],
        loading: false,
        feedback: {
          kind: "success",
          message: `Trackers on ${state.currentDomain} allowed`,
        },
      }))
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        feedback: { kind: "error", message: String(err) },
      }))
    }
  }, [state.currentDomain])

  const handleRemoveTrackingAllow = useCallback(async (domain: string) => {
    setState((prev) => ({ ...prev, loading: true }))
    try {
      const res = await sendMessage<{
        ok: boolean
        trackingAllowlist: string[]
      }>({
        type: "moveTrackingToBlocklist",
        domain,
      })
      setState((prev) => ({
        ...prev,
        trackingAllowlist: res.trackingAllowlist || [],
        loading: false,
        feedback: {
          kind: "info",
          message: `${domain} trackers blocked again`,
        },
      }))
    } catch (err) {
      setState((prev) => ({
        ...prev,
        loading: false,
        feedback: { kind: "error", message: String(err) },
      }))
    }
  }, [])

  const handleResetStats = useCallback(async () => {
    try {
      await sendMessage({ type: "resetStats" })
      setState((prev) => ({
        ...prev,
        adsBlocked: 0,
        trackersBlocked: 0,
        youtubeAdsBlocked: 0,
        checkedCount: 0,
        feedback: { kind: "info", message: "Stats reset" },
      }))
    } catch (err) {
      setState((prev) => ({
        ...prev,
        feedback: { kind: "error", message: String(err) },
      }))
    }
  }, [])

  if (state.loading && state.ruleCount === 0) {
    return (
      <Box
        bg={bgPage}
        minH="480px"
        w="360px"
        display="flex"
        alignItems="center"
        justifyContent="center"
      >
        <ProgressCircleRoot size="lg" colorPalette="orange">
          <ProgressCircleRing cap="round" />
        </ProgressCircleRoot>
      </Box>
    )
  }

  const isCurrentSiteAllowed =
    state.currentDomain && domainListed(state.siteAllowlist, state.currentDomain)

  const isCurrentTrackerAllowed =
    state.currentDomain &&
    domainListed(state.trackingAllowlist, state.currentDomain)

  const statusIcon = state.paused
    ? LuShieldAlert
    : isCurrentSiteAllowed
      ? LuShieldX
      : LuShieldCheck

  const statusColor = state.paused
    ? statusColorPaused
    : isCurrentSiteAllowed
      ? statusColorAllowed
      : accentBrown

  const statusText = state.paused
    ? "Protection Paused"
    : isCurrentSiteAllowed
      ? "Site Excluded"
      : "Protected"

  return (
    <Box bg={bgPage} w="360px" minH="480px" p="5">
      <VStack gap="3" align="stretch">
        {/* Header */}
        <HStack justify="space-between" align="center" pb="1">
          <HStack gap="2">
            <Box
              bg={accentBrown}
              p="2"
              rounded="md"
              display="flex"
              alignItems="center"
              justifyContent="center"
            >
              <Icon as={LuShield} color="white" boxSize="5" />
            </Box>
            <VStack gap="0" align="start">
              <Heading size="sm" color={textDark} fontWeight="bold">
                AdbloquRs
              </Heading>
              <Text fontSize="2xs" color={textMuted}>
                Rust + WASM Engine
              </Text>
            </VStack>
          </HStack>
          <ColorModeButton />
        </HStack>

        <Separator borderColor={cardBorder} />

        {/* Status banner */}
        <Flex
          bg={cardBg}
          p="4"
          rounded="xl"
          align="center"
          gap="3"
          borderWidth="1px"
          borderColor={cardBorder}
          boxShadow="sm"
        >
          <Box
            bg={`${statusColor}20`}
            p="2.5"
            rounded="lg"
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <Icon as={statusIcon} color={statusColor} boxSize="7" />
          </Box>
          <VStack gap="0" align="start" flex="1">
            <Text fontSize="xs" color={textMuted} fontWeight="medium">
              Status
            </Text>
            <Heading size="sm" color={textDark}>
              {statusText}
            </Heading>
          </VStack>
          {!state.paused && !isCurrentSiteAllowed && (
            <Badge
              bg={greenBg}
              color={greenFg}
              variant="subtle"
              fontSize="xs"
              px="2"
              py="0.5"
              rounded="full"
            >
              Active
            </Badge>
          )}
          {state.paused && (
            <Badge
              bg={orangeBg}
              color={orangeFg}
              variant="subtle"
              fontSize="xs"
              px="2"
              py="0.5"
              rounded="full"
            >
              Paused
            </Badge>
          )}
        </Flex>

        {/* Current site */}
        <Box
          bg={cardBg}
          p="4"
          rounded="xl"
          borderWidth="1px"
          borderColor={cardBorder}
          boxShadow="sm"
        >
          <Text fontSize="xs" color={textMuted} mb="2" fontWeight="medium">
            Current Site
          </Text>
          <HStack gap="2" mb="3">
            <Icon as={LuGlobe} color={accentBrown} boxSize="4" />
            <Text fontSize="sm" color={textDark} fontWeight="medium" truncate>
              {state.currentDomain || "No web page open"}
            </Text>
          </HStack>
          {state.currentDomain ? (
            isCurrentSiteAllowed ? (
              <Button
                size="sm"
                bg={blockBtnBg}
                color="white"
                _hover={{ bg: blockBtnHover }}
                w="full"
                rounded="lg"
                onClick={() =>
                  handleRemoveSiteFromAllowlist(state.currentDomain)
                }
                loading={state.loading}
              >
                <Icon as={LuBan} /> Move to Blocklist
              </Button>
            ) : (
              <Button
                size="sm"
                bg={accentBrown}
                color="white"
                _hover={{ bg: accentBrownDark }}
                w="full"
                rounded="lg"
                onClick={handleAddSiteToAllowlist}
                loading={state.loading}
                disabled={state.paused}
              >
                <Icon as={LuPlus} /> Add to Allowlist
              </Button>
            )
          ) : (
            <Text fontSize="xs" color={textMuted} textAlign="center" py="1">
              Open a page to manage this site's protection
            </Text>
          )}
        </Box>

        {/* Pause toggle */}
        <Flex
          bg={cardBg}
          p="4"
          rounded="xl"
          align="center"
          justify="space-between"
          borderWidth="1px"
          borderColor={cardBorder}
          boxShadow="sm"
        >
          <HStack gap="3">
            <Box
              bg={state.paused ? orangeBg : greenBg}
              p="2"
              rounded="lg"
              display="flex"
              alignItems="center"
              justifyContent="center"
            >
              <Icon
                as={state.paused ? LuPlay : LuPause}
                color={state.paused ? orangeFg : greenFg}
                boxSize="5"
              />
            </Box>
            <Box>
              <Text fontSize="sm" color={textDark} fontWeight="medium">
                {state.paused ? "Resume Blocking" : "Pause Blocking"}
              </Text>
              <Text fontSize="xs" color={textMuted}>
                {state.paused
                  ? "All requests currently allowed"
                  : "Filtering all network requests"}
              </Text>
            </Box>
          </HStack>
          <Switch
            checked={!state.paused}
            onCheckedChange={handleTogglePause}
            colorPalette={state.paused ? "orange" : "green"}
            aria-label="Toggle blocking"
          />
        </Flex>

        {/* Stats */}
        <Flex gap="2">
          <StatRoot
            flex="1"
            bg={cardBg}
            p="3"
            rounded="xl"
            borderWidth="1px"
            borderColor={cardBorder}
            boxShadow="sm"
          >
            <StatLabel fontSize="xs" color={textMuted}>
              Ads Blocked
            </StatLabel>
            <StatValueText
              value={state.adsBlocked}
              formatOptions={compactCount}
              fontSize="xl"
              color={adRed}
              fontWeight="bold"
            />
          </StatRoot>
          <StatRoot
            flex="1"
            bg={cardBg}
            p="3"
            rounded="xl"
            borderWidth="1px"
            borderColor={cardBorder}
            boxShadow="sm"
          >
            <StatLabel fontSize="xs" color={textMuted}>
              Trackers
            </StatLabel>
            <StatValueText
              value={state.trackersBlocked}
              formatOptions={compactCount}
              fontSize="xl"
              color={trackerOrange}
              fontWeight="bold"
            />
          </StatRoot>
          <StatRoot
            flex="1"
            bg={cardBg}
            p="3"
            rounded="xl"
            borderWidth="1px"
            borderColor={cardBorder}
            boxShadow="sm"
          >
            <StatLabel fontSize="xs" color={textMuted}>
              YouTube
            </StatLabel>
            <StatValueText
              value={state.youtubeAdsBlocked}
              formatOptions={compactCount}
              fontSize="xl"
              color={accentBrown}
              fontWeight="bold"
            />
          </StatRoot>
        </Flex>

        {/* Requests checked */}
        <Flex
          bg={cardBg}
          p="3"
          rounded="xl"
          align="center"
          justify="space-between"
          borderWidth="1px"
          borderColor={cardBorder}
          boxShadow="sm"
        >
          <Text fontSize="xs" color={textMuted}>
            Requests Checked
          </Text>
          <Text fontSize="sm" color={textDark} fontWeight="bold">
            {state.checkedCount.toLocaleString()}
          </Text>
        </Flex>

        {/* Allowed trackers */}
        <Box
          bg={cardBg}
          p="4"
          rounded="xl"
          borderWidth="1px"
          borderColor={cardBorder}
          boxShadow="sm"
        >
          <HStack justify="space-between" mb="2">
            <HStack gap="2">
              <Icon as={LuRadar} color={accentBrown} boxSize="4" />
              <Text fontSize="sm" color={textDark} fontWeight="medium">
                Allowed Trackers
              </Text>
            </HStack>
            <Badge
              bg={cardBorder}
              color={textMuted}
              variant="subtle"
              fontSize="xs"
              rounded="full"
            >
              {state.trackingAllowlist.length}
            </Badge>
          </HStack>
          {state.currentDomain &&
            !isCurrentTrackerAllowed &&
            !state.paused && (
              <Button
                size="xs"
                bg={chipBg}
                color={textDark}
                _hover={{ bg: chipHover }}
                variant="subtle"
                w="full"
                mb="2"
                rounded="lg"
                onClick={handleAllowCurrentTrackers}
                loading={state.loading}
              >
                <Icon as={LuRadar} /> Allow trackers on this site
              </Button>
            )}
          <Separator borderColor={cardBorder} mb="2" />
          {state.trackingAllowlist.length === 0 ? (
            <Text fontSize="xs" color={textMuted} py="2" textAlign="center">
              No tracking domains allowed
            </Text>
          ) : (
            <VStack
              gap="1"
              align="stretch"
              maxH="96px"
              overflowY="auto"
              css={{ scrollbarWidth: "thin" }}
            >
              {state.trackingAllowlist.map((domain) => (
                <HStack
                  key={domain}
                  justify="space-between"
                  py="1"
                  px="2"
                  rounded="md"
                  _hover={{ bg: hoverBg }}
                >
                  <Text fontSize="xs" color={textDark} truncate>
                    {domain}
                  </Text>
                  <IconButton
                    size="2xs"
                    variant="ghost"
                    colorPalette="red"
                    aria-label={`Block ${domain} again`}
                    onClick={() => handleRemoveTrackingAllow(domain)}
                  >
                    <LuTrash2 />
                  </IconButton>
                </HStack>
              ))}
            </VStack>
          )}
        </Box>

        {/* Allowlisted sites */}
        <Box
          bg={cardBg}
          p="4"
          rounded="xl"
          borderWidth="1px"
          borderColor={cardBorder}
          boxShadow="sm"
        >
          <HStack justify="space-between" mb="2">
            <HStack gap="2">
              <Icon as={LuShieldX} color={accentBrown} boxSize="4" />
              <Text fontSize="sm" color={textDark} fontWeight="medium">
                Allowlisted Sites
              </Text>
            </HStack>
            <Badge
              bg={cardBorder}
              color={textMuted}
              variant="subtle"
              fontSize="xs"
              rounded="full"
            >
              {state.siteAllowlist.length}
            </Badge>
          </HStack>
          <Separator borderColor={cardBorder} mb="2" />
          {state.siteAllowlist.length === 0 ? (
            <Text fontSize="xs" color={textMuted} py="2" textAlign="center">
              No allowlisted sites yet
            </Text>
          ) : (
            <VStack
              gap="1"
              align="stretch"
              maxH="96px"
              overflowY="auto"
              css={{ scrollbarWidth: "thin" }}
            >
              {state.siteAllowlist.map((domain) => (
                <HStack
                  key={domain}
                  justify="space-between"
                  py="1"
                  px="2"
                  rounded="md"
                  _hover={{ bg: hoverBg }}
                >
                  <Text fontSize="xs" color={textDark} truncate>
                    {domain}
                  </Text>
                  <IconButton
                    size="2xs"
                    variant="ghost"
                    colorPalette="red"
                    aria-label={`Remove ${domain}`}
                    onClick={() => handleRemoveSiteFromAllowlist(domain)}
                  >
                    <LuTrash2 />
                  </IconButton>
                </HStack>
              ))}
            </VStack>
          )}
        </Box>

        {/* Feedback alert */}
        {state.feedback && (
          <Alert
            status={state.feedback.kind}
            title={state.feedback.message}
            size="sm"
          />
        )}

        {/* YouTube Feature Badge */}
        <Flex
          bg={cardBg}
          p="3"
          rounded="xl"
          align="center"
          gap="3"
          borderWidth="1px"
          borderColor={cardBorder}
          boxShadow="sm"
        >
          <Box
            bg={blueBg}
            p="2"
            rounded="lg"
            display="flex"
            alignItems="center"
            justifyContent="center"
          >
            <Icon as={LuVideo} color={blueFg} boxSize="5" />
          </Box>
          <VStack gap="0" align="start" flex="1">
            <Text fontSize="sm" color={textDark} fontWeight="medium">
              YouTube Ad Removal
            </Text>
            <Text fontSize="xs" color={textMuted}>
              Skips video ads automatically
            </Text>
          </VStack>
          <Badge
            bg={greenBg}
            color={greenFg}
            variant="subtle"
            fontSize="xs"
            rounded="full"
          >
            Enabled
          </Badge>
        </Flex>

        {/* Footer */}
        <Flex justify="space-between" align="center" pt="1">
          <Text fontSize="2xs" color={textMuted}>
            v{state.version || "1.0.0"} · {state.ruleCount} ad /{" "}
            {state.trackingRuleCount} tracking rules
          </Text>
          <Button
            size="2xs"
            variant="ghost"
            color={textMuted}
            _hover={{ bg: hoverBg }}
            onClick={handleResetStats}
          >
            Reset Stats
          </Button>
        </Flex>
      </VStack>
    </Box>
  )
}
