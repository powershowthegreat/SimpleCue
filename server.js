import app from "./app.js";
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "0.0.0.0", (error) => {
  if (error) {
    console.error(
      `SimpleCue could not start on port ${port}: ${error.message}`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(`SimpleCue is ready at http://localhost:${port}`);
});
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => server.close(() => process.exit(0)));
