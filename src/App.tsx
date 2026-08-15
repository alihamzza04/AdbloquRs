import { Box, Heading } from "@chakra-ui/react"

function App() {
  return (
    <Box
      bg="bg"
      minH="100vh"
      display="flex"
      alignItems="center"
      justifyContent="center"
    >
      <Heading size="xl" color="fg">
        Start prompting to build with Chakra UI
      </Heading>
    </Box>
  )
}

export default App
