const express = require("express");
const dotenv = require("dotenv");
const cors = require("cors");

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");

dotenv.config();
const uri = process.env.MONGODB_URI;
const app = express();
const PORT = process.env.PORT;
app.use(cors());
app.use(express.json());
// getting mongodb to connect server
// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});
async function run() {
  try {
    await client.connect();

    const db = client.db("vestis");
    const productsCollection = db.collection("products");
    const cartsCollection = db.collection("cartCollection");
    const ordersCollection = db.collection("orders");
    const wishlistCollection = db.collection("wishlist");

    // getting products
    app.get("/products", async (req, res) => {
      try {
        const { gender, category, search, subcategory, sort, limit } =
          req.query;
        const query = { isActive: true };

        if (gender) {
          query.gender = gender.toLocaleLowerCase();
        }
        if (category) {
          query.category = category.toLocaleLowerCase();
        }
        if (subcategory) query.subcategory = subcategory.toLocaleLowerCase();
        if (search && search.trim().length > 1) {
          query.$or = [
            { name: { $regex: search.trim(), $options: "i" } },
            { category: { $regex: search.trim(), $options: "i" } },
            { brand: { $regex: search.trim(), $options: "i" } },
            { subcategory: { $regex: search.trim(), $options: "i" } },
            { gender: { $regex: search.trim(), $options: "i" } },
          ];
        }

        let sortQuery = {};
        if (sort === "Price: Low to High") sortQuery = { price: 1 };
        else if (sort === "Price: High to Low") sortQuery = { price: -1 };
        else sortQuery = { isFeatured: -1, createdAt: -1 };

        let productQuery = productsCollection.find(query).sort(sortQuery);
        if (limit) {
          productQuery = productQuery.limit(parseInt(limit));
        }

        const products = await productQuery.toArray();
        res.status(200).json({
          success: true,
          count: products.length,
          data: products,
        });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, message: "Internal Server Error" });
      }
    });

    // adding product to user cart
    app.post("/cart/add", async (req, res) => {
      const {
        guestId,
        userId,
        productId,
        size,
        quantity,
        price,
        name,
        brand,
        image,
        slug,
      } = req.body;
      const query = userId ? { userId } : { guestId };

      const cart = await cartsCollection.findOne(query);
      const newItem = {
        productId,
        size,
        quantity,
        price,
        name,
        brand,
        image,
        slug,
      };
      if (!cart) {
        await cartsCollection.insertOne({
          guestId: userId ? null : guestId,
          userId: userId || null,
          items: [newItem],
        });
        return res.json({ success: true });
      }
      const existingItem = cart.items.find(
        (i) => i.productId === productId && i.size === size,
      );
      if (existingItem) {
        await cartsCollection.updateOne(
          { ...query, "items.productId": productId, "items.size": size },
          {
            $inc: { "items.$.quantity": quantity },
          },
        );
      } else {
        await cartsCollection.updateOne(query, {
          $push: { items: newItem },
        });
      }
      res.json({ success: true });
    });
    // getting user cart item
    app.get("/cart", async (req, res) => {
      const { guestId, userId } = req.query;
      let cart;
      if (userId) {
        cart = await cartsCollection.findOne({ userId });
      } else {
        cart = await cartsCollection.findOne({ guestId });
      }
      if (!cart) {
        return res.json({ success: true, items: [] });
      }
      res.json({ success: true, items: cart.items });
    });
    // updating user item
    app.patch("/cart/update", async (req, res) => {
      const { guestId, userId, productId, size, quantity } = req.body;

      const query = userId
        ? { userId, "items.productId": productId, "items.size": size }
        : { guestId, "items.productId": productId, "items.size": size };

      await cartsCollection.updateOne(query, {
        $set: { "items.$.quantity": quantity },
      });
      res.json({ success: true });
    });
    // deleting user item
    app.delete("/cart/delete", async (req, res) => {
      const { guestId, userId, productId, size } = req.body;

      const query = userId
        ? { userId, "items.productId": productId, "items.size": size }
        : { guestId, "items.productId": productId, "items.size": size };

      await cartsCollection.updateOne(query, {
        $pull: { items: { productId, size } },
      });
      res.json({ success: true });
    });

    // merging guestId into user logged in userId
    app.post("/cart/merge", async (req, res) => {
      const { guestId, userId } = req.body;
      const guestCart = await cartsCollection.findOne({ guestId });
      if (!guestCart) {
        return res.json({ success: true });
      }
      const userCart = await cartsCollection.findOne({ userId });
      if (!userCart) {
        await cartsCollection.updateOne(
          { guestId },
          { $set: { userId, guestId: null } },
        );
      } else {
        for (const guestItem of guestCart.items) {
          const existingItem = userCart.items.find(
            (i) =>
              i.productId === guestItem.productId && i.size === guestItem.size,
          );

          if (existingItem) {
            await cartsCollection.updateOne(
              {
                userId,
                "items.productId": guestItem.productId,
                "items.size": guestItem.size,
              },
              { $inc: { "items.$.quantity": guestItem.quantity } },
            );
          } else {
            await cartsCollection.updateOne(
              { userId },
              { $push: { items: guestItem } },
            );
          }
        }
        await cartsCollection.deleteOne({ guestId });
      }
      res.json({ success: true });
    });

    // orders collection
    app.post("/order", async (req, res) => {
      const {
        userId,
        guestId,
        items,
        deliveryDetails,
        deliveryMethod,
        deliveryCharge,
        subtotal,
        total,
      } = req.body;
      if (
        !items?.length ||
        !deliveryDetails?.name ||
        !deliveryDetails.email ||
        (!userId && !guestId)
      ) {
        return res
          .status(400)
          .json({ success: false, message: "Invalid order data" });
      }
      const orderId = "ORD-" + crypto.randomUUID();
      await ordersCollection.insertOne({
        orderId,
        userId: userId || null,
        guestId: userId ? null : guestId,
        items,
        deliveryDetails,
        deliveryMethod,
        deliveryCharge,
        subtotal,
        total,
        status: "pending",
        createdAt: new Date(),
      });

      if (userId) {
        await cartsCollection.deleteOne({ userId });
      } else {
        await cartsCollection.deleteOne({ guestId });
      }
      res.json({ success: true, orderId });
    });

    // getting order details
    app.get("/order/:orderId", async (req, res) => {
      const { orderId } = req.params;
      const order = await ordersCollection.findOne({ orderId });
      if (!order) {
        return res
          .status(400)
          .json({ success: false, message: "Order not found" });
      }
      res.json({ success: true, order });
    });

    // getting user order
    app.get("/orders", async (req, res) => {
      const { userId } = req.query;
      if (!userId) {
        return res
          .status(400)
          .json({ success: false, message: "UserId required" });
      }
      const orders = await ordersCollection
        .find({ userId })
        .sort({ createdAt: -1 })
        .toArray();
      res.json({ success: true, orders });
    });

    // getting confirm order item by tracking
    app.get("/track-order", async (req, res) => {
      const { orderId, email } = req.query;
      const order = await ordersCollection.findOne({
        orderId,
        "deliveryDetails.email": email,
      });
      if (!order) {
        return res
          .status(400)
          .json({ success: false, message: "Order Not found" });
      }
      res.json({ success: true, order });
    });

    app.post("/wishlist/add", async (req, res) => {
      const { userId, guestId, productId, name, price, brand, slug, image } =
        req.body;
      const query = userId ? { userId } : { guestId };
      const wishlist = await wishlistCollection.findOne(query);
      const newItem = { productId, name, price, brand, image, slug };

      if (!wishlist) {
        await wishlistCollection.insertOne({
          userId: userId || null,
          guestId: userId ? null : guestId,
          items: [newItem],
        });
      } else {
        const existItem = wishlist.items.find((i) => i.productId === productId);
        if (existItem) {
          await wishlistCollection.updateOne(query, {
            $pull: { items: { productId } },
          });
        } else {
          await wishlistCollection.updateOne(query, {
            $push: { items: newItem },
          });
        }
      }
      res.json({ success: true });
    });
    app.get("/wishlist", async (req, res) => {
      const { userId, guestId } = req.query;
      const query = userId ? { userId } : { guestId };
      const wishlist = await wishlistCollection.findOne(query);
      if (!wishlist) {
        return res.json({ success: true, items: [] });
      }
      res.json({ success: true, items: wishlist.items });
    });

    app.delete("/wishlist/remove", async (req, res) => {
      const { userId, guestId, productId } = req.body;
      const query = userId ? { userId } : { guestId };

      await wishlistCollection.updateOne(query, {
        $pull: { items: { productId } },
      });

      res.json({ success: true });
    });
    // // merging all wishlist form guest id to userId
    // app.post("/wishlist/merge", async (req, res) => {
    //   const { guestId, userId } = req.body;

    //   const guestWishlist = await wishlistCollection.findOne({ guestId });
    //   if (!guestWishlist) return res.json({ success: true });

    //   const userWishlist = await wishlistCollection.findOne({ userId });

    //   if (!userWishlist) {
    //     // ── Guest wishlist → user এর করো
    //     await wishlistCollection.updateOne(
    //       { guestId },
    //       { $set: { userId, guestId: null } },
    //     );
    //   } else {
    //     // ── Duplicate ছাড়া items merge করো
    //     const newItems = guestWishlist.items.filter(
    //       (g) => !userWishlist.items.some((u) => u.productId === g.productId),
    //     );
    //     if (newItems.length > 0) {
    //       await wishlistCollection.updateOne(
    //         { userId },
    //         { $push: { items: { $each: newItems } } },
    //       );
    //     }
    //     await wishlistCollection.deleteOne({ guestId });
    //   }

    //   res.json({ success: true });
    // });

    // getting related products
    app.get("/products/related", async (req, res) => {
      const { category, gender, exclude } = req.query;
      const products = await productsCollection
        .find({
          gender,
          category,
          _id: { $ne: new ObjectId(exclude) },
          isActive: true,
        })
        .limit(8)
        .toArray();
      res.json({ success: true, data: products });
    });

    // getting products
    app.get("/products", async (req, res) => {
      try {
        const { gender, category, search, subcategory, sort, limit } =
          req.query;
        const query = { isActive: true };

        if (gender) {
          query.gender = gender.toLocaleLowerCase();
        }
        if (category) {
          query.category = category.toLocaleLowerCase();
        }
        if (subcategory) query.subcategory = subcategory.toLocaleLowerCase();
        if (search && search.trim().length > 1) {
          query.$or = [
            { name: { $regex: search.trim(), $options: "i" } },
            { category: { $regex: search.trim(), $options: "i" } },
            { brand: { $regex: search.trim(), $options: "i" } },
            { subcategory: { $regex: search.trim(), $options: "i" } },
            { gender: { $regex: search.trim(), $options: "i" } },
          ];
        }

        let sortQuery = {};
        if (sort === "Price: Low to High") sortQuery = { price: 1 };
        else if (sort === "Price: High to Low") sortQuery = { price: -1 };
        else sortQuery = { isFeatured: -1, createdAt: -1 };

        let productQuery = productsCollection.find(query).sort(sortQuery);
        if (limit) {
          productQuery = productQuery.limit(parseInt(limit));
        }

        const products = await productQuery.toArray();
        res.status(200).json({
          success: true,
          count: products.length,
          data: products,
        });
      } catch (error) {
        res
          .status(500)
          .json({ success: false, message: "Internal Server Error" });
      }
    });

    // getting single product
    app.get("/product/:slug", async (req, res) => {
      const { slug } = req.params;
      const result = await productsCollection.findOne({ slug: slug });
      console.log("this is product slug:", result);
      res.json(result);
    });

    // posting product
    app.post("/product", async (req, res) => {
      const product = req.body;
      const result = await productsCollection.insertOne(product);
      res.json(result);
    });

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!",
    );
  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

app.get("/", (req, res) => {
  res.send("server running properly mr aminul");
});

app.listen(PORT, () => {
  console.log("server running on port ", PORT);
});
