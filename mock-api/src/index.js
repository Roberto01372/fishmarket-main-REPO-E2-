const dotenv = require("dotenv");
const path = require("path");

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "..", ".env") });

dotenv.config({ path: path.resolve(__dirname, "..", ".env.example") });

const app = require("./app");

const port = Number(process.env.PORT || 3000);

app.listen(port, "0.0.0.0", () => {
  console.log(`Order service listening on port ${port}`);
});
